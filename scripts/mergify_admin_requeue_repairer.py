from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
from typing import Mapping, Sequence

try:
    from .mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger, MergifyQueueEvent, PrSnapshot, RepairOutcome
    from .mergify_admin_requeue_plan import TRUNK, is_queue_only_required_check
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, run_logged
except ImportError:
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger, MergifyQueueEvent, PrSnapshot, RepairOutcome
    from mergify_admin_requeue_plan import TRUNK, is_queue_only_required_check
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head, run_logged


REPO_ROOT = Path(__file__).resolve().parents[1]
PROOF_POLICY_LANE_ERROR = (
    "Review lane proof cannot ship with policy files in the same PR. "
    "Keep benchmarks, repros, and regression proof separate from behavior or policy changes."
)
PROOF_TOOLING_POLICY_UNIT_ERROR = (
    'PR body Review Unit "proof" cannot ship with tooling-policy files in the same PR. '
    "Split this into one Review Unit per PR."
)
NON_TRUNK_PREREQ_ERROR = "automatic tooling-policy split is only supported for base master"
NON_TRUNK_MANUAL_SPLIT_ERROR = "worker cannot auto-split this PR on a non-trunk base; human stack split required"


def mergify_check_urls(event: MergifyQueueEvent | None, check_name: str) -> tuple[str, ...]:
    if not event:
        return ()
    for name, urls in event.failing_check_urls:
        if name == check_name:
            return urls
    return ()


class AdminBypassRepairer:
    def __init__(
        self,
        gh: GhClient,
        executor: AdminBypassGhExecutor,
        logger: AdminBypassLogger,
        ledger: Ledger,
        repo: str,
    ):
        self.gh = gh
        self.executor = executor
        self.logger = logger
        self.ledger = ledger
        self.repo = repo

    def git_output(self, work_root: Path, *args: str) -> str:
        return run_logged(["git", *args], cwd=work_root)

    def git_lines(self, work_root: Path, *args: str) -> tuple[str, ...]:
        return tuple(line.strip() for line in self.git_output(work_root, *args).splitlines() if line.strip())

    def hard_reset_work_root(self, work_root: Path, target: str) -> None:
        self.git_output(work_root, "reset", "--hard", target)
        self.git_output(work_root, "clean", "-fd")

    def validate_local_pr_body(self, work_root: Path, body: str, base_branch: str) -> dict[str, object]:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
            handle.write(body)
            body_path = Path(handle.name)
        try:
            completed = subprocess.run(
                [
                    "node",
                    str(REPO_ROOT / "scripts" / "validate-pr-body-local.mjs"),
                    "--body-file",
                    str(body_path),
                    "--base",
                    base_branch,
                    "--json",
                ],
                cwd=str(work_root),
                check=False,
                text=True,
                capture_output=True,
            )
            stdout = completed.stdout.strip()
            if completed.returncode not in {0, 1}:
                raise RuntimeError(completed.stderr.strip() or stdout or "validate-pr-body-local failed")
            if not stdout:
                raise RuntimeError(completed.stderr.strip() or "validate-pr-body-local produced no JSON output")
            value = json.loads(stdout)
            if not isinstance(value, dict):
                raise RuntimeError("validate-pr-body-local returned non-object JSON")
            return value
        finally:
            body_path.unlink(missing_ok=True)

    def validate_pr_body_from_current_diff(self, work_root: Path, body: str, base_branch: str) -> dict[str, object]:
        self.git_output(work_root, "fetch", "origin", f"+refs/heads/{base_branch}:refs/remotes/origin/{base_branch}")
        changed_files = self.git_output(work_root, "diff", "--name-only", f"origin/{base_branch}...HEAD")
        diff_text = self.git_output(work_root, "diff", "--no-ext-diff", f"origin/{base_branch}...HEAD")
        with (
            tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as body_handle,
            tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as changed_handle,
            tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as diff_handle,
        ):
            body_handle.write(body)
            changed_handle.write(changed_files)
            diff_handle.write(diff_text)
            body_path = Path(body_handle.name)
            changed_path = Path(changed_handle.name)
            diff_path = Path(diff_handle.name)
        script = (
            "import { readFileSync } from 'node:fs';"
            f"import {{ getReviewMetadata, scopeKindsForChangedFiles, validatePrBody }} from '{(REPO_ROOT / 'scripts' / 'validate-pr-body.mjs').as_posix()}';"
            f"import {{ reviewUnitsForChangedFiles }} from '{(REPO_ROOT / 'scripts' / 'review-unit-rules.mjs').as_posix()}';"
            "const body = readFileSync(process.argv[1], 'utf8');"
            "const changedFiles = readFileSync(process.argv[2], 'utf8').split(/\\r?\\n/).filter(Boolean);"
            "const diffText = readFileSync(process.argv[3], 'utf8');"
            "const errors = await validatePrBody(body, { changedFiles, diffText });"
            "const reviewMetadata = getReviewMetadata(body.trim());"
            "console.log(JSON.stringify({"
            "valid: errors.length === 0,"
            "errors,"
            "reviewLane: reviewMetadata.reviewLane,"
            "reviewUnit: reviewMetadata.reviewUnit,"
            "reviewUnits: reviewUnitsForChangedFiles(changedFiles),"
            "scopeKinds: scopeKindsForChangedFiles(changedFiles),"
            "}));"
        )
        try:
            completed = subprocess.run(
                ["node", "--input-type=module", "-e", script, str(body_path), str(changed_path), str(diff_path)],
                cwd=str(work_root),
                check=False,
                text=True,
                capture_output=True,
            )
            stdout = completed.stdout.strip()
            if completed.returncode not in {0, 1}:
                raise RuntimeError(completed.stderr.strip() or stdout or "validate-pr-body fallback failed")
            if not stdout:
                raise RuntimeError(completed.stderr.strip() or "validate-pr-body fallback produced no JSON output")
            value = json.loads(stdout)
            if not isinstance(value, dict):
                raise RuntimeError("validate-pr-body fallback returned non-object JSON")
            return value
        finally:
            body_path.unlink(missing_ok=True)
            changed_path.unlink(missing_ok=True)
            diff_path.unlink(missing_ok=True)

    def validate_current_pr_body(self, work_root: Path, body: str, base_branch: str) -> dict[str, object]:
        try:
            return self.validate_local_pr_body(work_root, body, base_branch)
        except RuntimeError:
            return self.validate_pr_body_from_current_diff(work_root, body, base_branch)

    def is_proof_tooling_policy_validation(self, value: Mapping[str, object]) -> bool:
        errors = value.get("errors")
        scope_kinds = value.get("scopeKinds")
        review_units = value.get("reviewUnits")
        if value.get("reviewLane") != "proof" or value.get("reviewUnit") != "proof":
            return False
        if review_units != ["tooling-policy"]:
            return False
        if scope_kinds not in ([], ["policy"]):
            return False
        if not isinstance(errors, list):
            return False
        return bool(errors) and set(errors).issubset({PROOF_POLICY_LANE_ERROR, PROOF_TOOLING_POLICY_UNIT_ERROR})

    def is_prereq_split_validation(self, value: Mapping[str, object], pr: PrSnapshot) -> bool:
        return pr.base_ref_name == TRUNK and self.is_proof_tooling_policy_validation(value)

    def is_manual_split_validation(self, value: Mapping[str, object]) -> bool:
        errors = value.get("errors")
        review_units = value.get("reviewUnits")
        if not isinstance(errors, list) or not errors:
            return False
        if not isinstance(review_units, list):
            return False
        if "tooling-policy" not in review_units or "proof" not in review_units:
            return False
        joined = "\n".join(str(error) for error in errors)
        return (
            "multiple review units" in joined
            or "Split this into one Review Unit per PR." in joined
            or "cannot ship with policy, proof files" in joined
            or "cannot ship with tooling-policy, proof files" in joined
        )

    def invalid_repair_errors(self, value: Mapping[str, object], pr: PrSnapshot) -> list[str]:
        errors = [str(error) for error in value.get("errors", [])]
        if self.is_proof_tooling_policy_validation(value) and pr.base_ref_name != TRUNK:
            errors = [*errors, NON_TRUNK_PREREQ_ERROR]
        if self.is_manual_split_validation(value) and pr.base_ref_name != TRUNK:
            errors = [*errors, NON_TRUNK_MANUAL_SPLIT_ERROR]
        return errors

    def invalid_repair_outcome(
        self,
        pr: PrSnapshot,
        check_name: str,
        start_head: str,
        end_head: str,
        value: Mapping[str, object],
        *,
        repair_commits: Sequence[str] = (),
    ) -> RepairOutcome:
        return self.blocked_outcome(
            "blocked_invalid",
            check_name,
            start_head,
            end_head,
            repair_commits=repair_commits,
            errors=self.invalid_repair_errors(value, pr),
        )

    def prerequisite_branch_name(self, pr: PrSnapshot, start_head: str) -> str:
        return f"stack/pr-babysit-prereq-{pr.number}-{start_head[:7]}"

    def prerequisite_title(self, pr: PrSnapshot, check_name: str) -> str:
        return f"[PR babysit] Tooling-policy repair prerequisite for #{pr.number}: {check_name}"

    def prerequisite_body(self, pr: PrSnapshot, check_name: str) -> str:
        return (
            "## Summary\n\n"
            "Worker-generated tooling-policy repair.\n\n"
            "## Review Claim\n\n"
            f"This PR carries the worker-generated tooling-policy repair that unblocks {check_name} on #{pr.number}.\n\n"
            "## Review Lane\n\n"
            "- policy\n\n"
            "## Review Unit\n\n"
            "- tooling-policy\n\n"
            "## Safety Invariant\n\n"
            "Contains only the worker-generated repair commit; the original PR branch stays proof-only.\n\n"
            "## Slice Rationale\n\n"
            "The repair changed tooling-policy files that a proof PR body cannot carry, so the repair must land first.\n\n"
            "## Non-goals\n\n"
            "- No product behavior change.\n\n"
            "## Test Plan\n\n"
            "<details>\n"
            "<summary>Test Plan</summary>\n\n"
            f"- [ ] Let CI rerun {check_name}.\n\n"
            "</details>\n\n"
            "## Revert Plan\n\n"
            "<details>\n"
            "<summary>Revert Plan</summary>\n\n"
            "- Safe to revert? Yes.\n"
            "- Revert command: `git revert <sha>`\n"
            "- Post-revert steps: None.\n"
            "- Data migration? No.\n\n"
            "</details>\n"
        )

    def blocked_outcome(
        self,
        status: str,
        check_name: str,
        start_head: str,
        end_head: str,
        *,
        repair_commits: Sequence[str] = (),
        status_lines: Sequence[str] = (),
        errors: Sequence[str] = (),
        prereq: Mapping[str, object] | None = None,
    ) -> RepairOutcome:
        return RepairOutcome(
            status=status,
            check_name=check_name,
            start_head=start_head,
            end_head=end_head,
            repair_commits=tuple(repair_commits),
            status_lines=tuple(status_lines),
            errors=tuple(errors),
            prereq=prereq,
        )

    def push_branch(self, work_root: Path, branch_name: str) -> None:
        self.git_output(work_root, "push", "origin", f"HEAD:{branch_name}")

    def create_repair_prerequisite(
        self,
        pr: PrSnapshot,
        check_name: str,
        start_head: str,
        repair_commits: Sequence[str],
        work_root: Path,
        now: int | None,
    ) -> dict[str, object]:
        branch_name = self.prerequisite_branch_name(pr, start_head)
        title = self.prerequisite_title(pr, check_name)
        body = self.prerequisite_body(pr, check_name)
        self.git_output(work_root, "checkout", "-B", branch_name, f"origin/{TRUNK}")
        self.git_output(work_root, "reset", "--hard", f"origin/{TRUNK}")
        for commit in repair_commits:
            self.git_output(work_root, "cherry-pick", commit)
        validation = self.validate_current_pr_body(work_root, body, TRUNK)
        if not validation.get("valid"):
            errors = [str(error) for error in validation.get("errors", [])]
            raise RuntimeError("prerequisite PR body failed validation: " + "; ".join(errors))
        self.push_branch(work_root, branch_name)
        created = self.gh.create_pr(self.repo, title, body, branch_name, TRUNK)
        prereq_number = int(created.get("number") or 0)
        if prereq_number <= 0:
            raise RuntimeError("GitHub did not return a prerequisite PR number")
        self.gh.edit_label(self.repo, prereq_number, add="admin-bypass")
        self.ledger.record(
            "repair-prereq-created",
            pr.number,
            pr.head_ref_oid,
            check_name,
            now,
            meta={"prNumber": prereq_number, "branch": branch_name},
        )
        self.logger.trace(
            "admin-bypass-repair-prereq-created",
            repo=self.repo,
            pr_number=pr.number,
            check_name=check_name,
            prereq_pr_number=prereq_number,
            prereq_branch=branch_name,
            repair_commits=list(repair_commits),
        )
        return {"prNumber": prereq_number, "branch": branch_name, "title": title}

    def run_claude_repair(self, work_root: Path, prompt: str) -> None:
        subprocess.run(
            ["claude", "-p", prompt, "--dangerously-skip-permissions"],
            cwd=str(work_root),
            check=True,
            text=True,
        )

    def repair_check(self, pr: PrSnapshot, check_name: str, now: int | None = None) -> RepairOutcome:
        ctx = pr.checks.get(check_name)
        latest = pr.latest_mergify
        queue_only = ctx is None and is_queue_only_required_check(check_name)
        mergify_urls = mergify_check_urls(latest, check_name)
        details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        start_head = self.git_output(work_root, "rev-parse", "HEAD").strip()
        if queue_only and not details_url:
            return self.blocked_outcome(
                "blocked_invalid",
                check_name,
                start_head,
                start_head,
                errors=(f"queue-only check {check_name} is missing a Mergify job URL",),
            )
        log_path = self.executor.download_job_log(self.repo, details_url, pr.number, check_name) if details_url else ""
        queue_pr_number = latest.queue_pr_number if latest else 0
        prompt = (
            f"Fix only the failing check. Add or update a repro if the failure is reproducible. "
            f"Commit locally if needed, do not push. If local proof shows the check is already green on the current head, make no commit and exit 0.\n\n"
            f"PR: #{pr.number}\nFailed check: {check_name}\nDetails URL: {details_url}\nJob log path: {log_path}\n"
            f"Latest Mergify event: {json.dumps(latest.__dict__ if latest else None, sort_keys=True)}\n"
        )
        if queue_only:
            prompt += f"Queue draft PR: #{queue_pr_number}\nRepair the real PR head, using only evidence from the queue draft failure.\n"
        self.logger.trace(
            "admin-bypass-repair-check-start",
            repo=self.repo,
            pr_number=pr.number,
            check_name=check_name,
            details_url=details_url,
            log_path=log_path,
            work_root=str(work_root),
            head_sha=pr.head_ref_oid,
        )
        self.run_claude_repair(work_root, prompt)
        end_head = self.git_output(work_root, "rev-parse", "HEAD").strip()
        status_lines = self.git_lines(work_root, "status", "--porcelain")
        if end_head == start_head and not status_lines:
            if not queue_only:
                validation = self.validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
                if not validation.get("valid"):
                    return self.invalid_repair_outcome(pr, check_name, start_head, end_head, validation)
            return self.blocked_outcome(
                "queue_only_noop" if queue_only else "noop",
                check_name,
                start_head,
                end_head,
            )
        if status_lines:
            self.hard_reset_work_root(work_root, start_head)
            return self.blocked_outcome(
                "blocked_dirty",
                check_name,
                start_head,
                end_head,
                status_lines=status_lines,
            )
        repair_commits = self.git_lines(work_root, "rev-list", "--reverse", f"{start_head}..{end_head}")
        validation = self.validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
        if validation.get("valid"):
            self.push_branch(work_root, pr.head_ref_name)
            return self.blocked_outcome(
                "pushed",
                check_name,
                start_head,
                end_head,
                repair_commits=repair_commits,
            )
        if self.is_prereq_split_validation(validation, pr):
            try:
                created = self.create_repair_prerequisite(pr, check_name, start_head, repair_commits, work_root, now)
            finally:
                self.git_output(work_root, "checkout", "-B", pr.head_ref_name, start_head)
                self.hard_reset_work_root(work_root, start_head)
            return self.blocked_outcome(
                "prereq_created",
                check_name,
                start_head,
                end_head,
                repair_commits=repair_commits,
                prereq=created,
            )
        self.hard_reset_work_root(work_root, start_head)
        return self.invalid_repair_outcome(
            pr,
            check_name,
            start_head,
            end_head,
            validation,
            repair_commits=repair_commits,
        )

    def repair_conflict(self, pr: PrSnapshot, reason: str) -> None:
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        prompt = (
            f"Resolve only the merge conflict that keeps this PR from merging. "
            f"Rebase the PR head branch onto its base branch, preserve the PR's intended changes, "
            f"run the narrow proof for the conflict resolution, then commit and push to the PR head branch. "
            f"If the PR is already closed or merged, or the head branch no longer exists, make no commit and exit 0.\n\n"
            f"PR: #{pr.number}\nBase branch: {pr.base_ref_name}\nHead branch: {pr.head_ref_name}\n"
            f"Head SHA: {pr.head_ref_oid}\nReason: {reason}\n"
        )
        self.logger.trace(
            "admin-bypass-repair-conflict-start",
            repo=self.repo,
            pr_number=pr.number,
            reason=reason,
            work_root=str(work_root),
            base_ref=pr.base_ref_name,
            head_ref=pr.head_ref_name,
            head_sha=pr.head_ref_oid,
        )
        self.run_claude_repair(work_root, prompt)

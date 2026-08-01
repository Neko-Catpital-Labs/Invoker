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
    from .mergify_admin_requeue_repair_body import (
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        validate_current_pr_body,
    )
    from .mergify_admin_requeue_snapshot import GhClient, checkout_pr_head
    from .pr_worker_safe_push import SafePushError, safe_push
except ImportError:
    from mergify_admin_requeue_gh_executor import AdminBypassGhExecutor
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger, MergifyQueueEvent, PrSnapshot, RepairOutcome
    from mergify_admin_requeue_plan import TRUNK, is_queue_only_required_check
    from mergify_admin_requeue_repair_body import (
        git_lines,
        git_output,
        hard_reset_work_root,
        invalid_repair_errors,
        is_prereq_split_validation,
        normalize_repair_commit,
        validate_current_pr_body,
    )
    from mergify_admin_requeue_snapshot import GhClient, checkout_pr_head
    from pr_worker_safe_push import SafePushError, safe_push


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
            errors=invalid_repair_errors(value, pr),
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

    def push_branch(
        self,
        work_root: Path,
        branch_name: str,
        *,
        expected_head: str | None = None,
        expect_missing: bool = False,
    ) -> str:
        return safe_push(
            branch=branch_name,
            expected_head=expected_head,
            expect_missing=expect_missing,
            cwd=work_root,
        )

    def terminal_repair_outcome(
        self,
        pr: PrSnapshot,
        check_name: str,
        start_head: str,
        end_head: str,
        work_root: Path,
    ) -> RepairOutcome | None:
        if not hasattr(self.gh, "pr_detail"):
            return None
        detail = self.gh.pr_detail(self.repo, pr.number)
        state = str(detail.get("state") or pr.state)
        if state == "OPEN":
            return None
        self.logger.trace(
            "admin-bypass-repair-check-terminal",
            repo=self.repo,
            pr_number=pr.number,
            check_name=check_name,
            state=state,
            start_head=start_head,
            end_head=end_head,
        )
        hard_reset_work_root(work_root, start_head)
        return self.blocked_outcome("noop", check_name, start_head, end_head)

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
        git_output(work_root, "checkout", "-B", branch_name, f"origin/{TRUNK}")
        git_output(work_root, "reset", "--hard", f"origin/{TRUNK}")
        for commit in repair_commits:
            git_output(work_root, "cherry-pick", commit)
        validation = validate_current_pr_body(work_root, body, TRUNK)
        if not validation.get("valid"):
            errors = [str(error) for error in validation.get("errors", [])]
            raise RuntimeError("prerequisite PR body failed validation: " + "; ".join(errors))
        self.push_branch(work_root, branch_name, expect_missing=True)
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

    def job_log_has_evidence(self, log_path: str) -> bool:
        if not log_path:
            return False
        try:
            return bool(Path(log_path).read_text(encoding="utf-8").strip())
        except OSError:
            return False

    def job_log_is_empty(self, log_path: str) -> bool:
        if not log_path:
            return False
        path = Path(log_path)
        if not path.exists():
            return False
        try:
            return not path.read_text(encoding="utf-8").strip()
        except OSError:
            return False

    def repair_check(self, pr: PrSnapshot, check_name: str, now: int | None = None) -> RepairOutcome:
        self.ledger.record("repair-check", pr.number, pr.head_ref_oid, check_name, now)
        ctx = pr.checks.get(check_name)
        latest = pr.latest_mergify
        queue_only = ctx is None and is_queue_only_required_check(check_name)
        mergify_urls = mergify_check_urls(latest, check_name)
        details_url = (ctx.details_url if ctx and ctx.details_url else "") or (mergify_urls[0] if mergify_urls else "")
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        start_head = git_output(work_root, "rev-parse", "HEAD").strip()
        if queue_only and not details_url:
            return self.blocked_outcome(
                "blocked_invalid",
                check_name,
                start_head,
                start_head,
                errors=(f"queue-only check {check_name} is missing a Mergify job URL",),
            )
        log_path = self.executor.download_job_log(self.repo, details_url, pr.number, check_name) if details_url else ""
        if check_name == "PR Body" and self.job_log_is_empty(log_path):
            terminal = self.terminal_repair_outcome(pr, check_name, start_head, start_head, work_root)
            if terminal:
                return terminal
            validation = validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
            if validation.get("valid"):
                self.logger.trace(
                    "admin-bypass-pr-body-valid-noop",
                    repo=self.repo,
                    pr_number=pr.number,
                    check_name=check_name,
                    head_sha=pr.head_ref_oid,
                    details_url=details_url,
                    log_path=log_path,
                )
                return self.blocked_outcome("noop", check_name, start_head, start_head)
        if queue_only and not self.job_log_has_evidence(log_path):
            self.logger.trace(
                "admin-bypass-queue-only-empty-log-noop",
                repo=self.repo,
                pr_number=pr.number,
                check_name=check_name,
                details_url=details_url,
                log_path=log_path,
                head_sha=pr.head_ref_oid,
            )
            return self.blocked_outcome(
                "queue_only_noop",
                check_name,
                start_head,
                start_head,
            )
        queue_pr_number = latest.queue_pr_number if latest else 0
        prompt = (
            f"This PR's CI check is failing. Diagnose why it is failing, then fix it. Add or update a repro if the failure is reproducible.\n\n"
            f"If a code change fixes it: make the change in this checkout. Commit locally if needed, do not push. "
            f"If local proof shows the check is already green on the current head, make no commit and exit 0.\n\n"
            f"If the real fix requires restructuring this PR instead of editing it in place -- for example, splitting "
            f"unrelated files into their own PR because they can't ship together -- do not force that into a single "
            f"local commit here. Instead, submit an Invoker plan to do the restructuring, the same way a human would "
            f"via the plan-to-invoker skill (see skills/plan-to-invoker/SKILL.md and ./submit-plan.sh). Then make no "
            f"commit in this checkout and exit 0.\n\n"
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
        end_head = git_output(work_root, "rev-parse", "HEAD").strip()
        status_lines = git_lines(work_root, "status", "--porcelain")
        terminal = self.terminal_repair_outcome(pr, check_name, start_head, end_head, work_root)
        if terminal:
            return terminal
        if end_head == start_head and not status_lines:
            if not queue_only:
                validation = validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
                if not validation.get("valid"):
                    return self.invalid_repair_outcome(pr, check_name, start_head, end_head, validation)
            return self.blocked_outcome(
                "queue_only_noop" if queue_only else "noop",
                check_name,
                start_head,
                end_head,
            )
        if status_lines:
            hard_reset_work_root(work_root, start_head)
            return self.blocked_outcome(
                "blocked_dirty",
                check_name,
                start_head,
                end_head,
                status_lines=status_lines,
            )
        end_head = normalize_repair_commit(work_root, start_head, end_head, check_name)
        repair_commits = git_lines(work_root, "rev-list", "--reverse", f"{start_head}..{end_head}")
        validation = validate_current_pr_body(work_root, pr.body, pr.base_ref_name)
        if validation.get("valid"):
            try:
                self.push_branch(work_root, pr.head_ref_name, expected_head=pr.head_ref_oid)
            except SafePushError as exc:
                return self.blocked_outcome(
                    "stale_head",
                    check_name,
                    start_head,
                    end_head,
                    repair_commits=repair_commits,
                    errors=(str(exc),),
                )
            return self.blocked_outcome(
                "pushed",
                check_name,
                start_head,
                end_head,
                repair_commits=repair_commits,
            )
        if is_prereq_split_validation(validation, pr):
            try:
                created = self.create_repair_prerequisite(pr, check_name, start_head, repair_commits, work_root, now)
            finally:
                git_output(work_root, "checkout", "-B", pr.head_ref_name, start_head)
                hard_reset_work_root(work_root, start_head)
            return self.blocked_outcome(
                "prereq_created",
                check_name,
                start_head,
                end_head,
                repair_commits=repair_commits,
                prereq=created,
            )
        hard_reset_work_root(work_root, start_head)
        return self.invalid_repair_outcome(
            pr,
            check_name,
            start_head,
            end_head,
            validation,
            repair_commits=repair_commits,
        )

    def repair_conflict(self, pr: PrSnapshot, reason: str, now: int | None = None) -> RepairOutcome:
        check_name = "conflict"
        self.ledger.record("conflict-repair", pr.number, pr.head_ref_oid, f"conflict:{pr.number}", now)
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        start_head = git_output(work_root, "rev-parse", "HEAD").strip()
        prompt = (
            f"This PR has a merge conflict blocking it from merging. Diagnose why, then fix it.\n\n"
            f"If rebasing the head branch onto its base branch (preserving the PR's intended changes) resolves it: "
            f"do that, run the narrow proof for the conflict resolution, then commit locally. Do not push.\n\n"
            f"If the real fix requires restructuring this PR instead of a straightforward rebase, do not force that "
            f"into a single local commit here. Instead, submit an Invoker plan to do the restructuring, the same way "
            f"a human would via the plan-to-invoker skill (see skills/plan-to-invoker/SKILL.md and ./submit-plan.sh). "
            f"Then make no commit in this checkout and exit 0.\n\n"
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
        end_head = git_output(work_root, "rev-parse", "HEAD").strip()
        status_lines = git_lines(work_root, "status", "--porcelain")
        if end_head == start_head or status_lines:
            if status_lines:
                hard_reset_work_root(work_root, start_head)
                return self.blocked_outcome(
                    "blocked_dirty",
                    check_name,
                    start_head,
                    end_head,
                    status_lines=status_lines,
                )
            return self.blocked_outcome("noop", check_name, start_head, end_head)
        try:
            self.push_branch(work_root, pr.head_ref_name, expected_head=pr.head_ref_oid)
        except SafePushError as exc:
            return self.blocked_outcome(
                "stale_head",
                check_name,
                start_head,
                end_head,
                errors=(str(exc),),
            )
        return self.blocked_outcome("pushed", check_name, start_head, end_head)

    def repair_bot_thread(self, pr: PrSnapshot, thread_id: str, now: int | None = None) -> RepairOutcome:
        self.ledger.record("repair-bot-thread", pr.number, pr.head_ref_oid, thread_id, now)
        work_root = Path(os.environ.get("HOME", ".")) / ".invoker" / "mergify-admin-requeue-work" / str(pr.number)
        work_root.parent.mkdir(parents=True, exist_ok=True)
        checkout_pr_head(self.repo, pr, work_root)
        start_head = git_output(work_root, "rev-parse", "HEAD").strip()
        prompt = (
            f"Resolve the unresolved review thread {thread_id}. Address the reviewer's feedback with "
            f"real code changes, run the narrow proof for the fix, then commit locally. Do not push. "
            f"If the thread is already resolved, or the PR is closed or merged, make no commit and exit 0.\n\n"
            f"PR: #{pr.number}\nHead branch: {pr.head_ref_name}\nHead SHA: {pr.head_ref_oid}\nThread: {thread_id}\n"
        )
        self.logger.trace(
            "admin-bypass-repair-bot-thread-start",
            repo=self.repo,
            pr_number=pr.number,
            thread_id=thread_id,
            work_root=str(work_root),
            head_sha=pr.head_ref_oid,
        )
        self.run_claude_repair(work_root, prompt)
        end_head = git_output(work_root, "rev-parse", "HEAD").strip()
        status_lines = git_lines(work_root, "status", "--porcelain")
        if end_head == start_head or status_lines:
            if status_lines:
                hard_reset_work_root(work_root, start_head)
                return self.blocked_outcome(
                    "blocked_dirty",
                    thread_id,
                    start_head,
                    end_head,
                    status_lines=status_lines,
                )
            return self.blocked_outcome("noop", thread_id, start_head, end_head)
        try:
            self.push_branch(work_root, pr.head_ref_name, expected_head=pr.head_ref_oid)
        except SafePushError as exc:
            return self.blocked_outcome(
                "stale_head",
                thread_id,
                start_head,
                end_head,
                errors=(str(exc),),
            )
        return self.blocked_outcome("pushed", thread_id, start_head, end_head)

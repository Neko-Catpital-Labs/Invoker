from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path
from typing import Mapping, Sequence

try:
    from .mergify_admin_requeue_logger import AdminBypassLogger
    from .mergify_admin_requeue_model import Ledger
    from .mergify_admin_requeue_plan import TRUNK
    from .mergify_admin_requeue_snapshot import GhClient, run_logged
    from .pr_worker_safe_push import safe_push
except ImportError:
    from mergify_admin_requeue_logger import AdminBypassLogger
    from mergify_admin_requeue_model import Ledger
    from mergify_admin_requeue_plan import TRUNK
    from mergify_admin_requeue_snapshot import GhClient, run_logged
    from pr_worker_safe_push import safe_push


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


def git_output(cwd: Path, *args: str) -> str:
    return run_logged(["git", *args], cwd=cwd)


def git_lines(cwd: Path, *args: str) -> tuple[str, ...]:
    return tuple(line.strip() for line in git_output(cwd, *args).splitlines() if line.strip())


def hard_reset_work_root(cwd: Path, target: str) -> None:
    git_output(cwd, "reset", "--hard", target)
    git_output(cwd, "clean", "-fd")


def is_ancestor(cwd: Path, ancestor: str, descendant: str) -> bool:
    if not cwd.exists():
        return True
    completed = subprocess.run(
        ["git", "merge-base", "--is-ancestor", ancestor, descendant],
        cwd=str(cwd),
        check=False,
        text=True,
        capture_output=True,
    )
    return completed.returncode == 0


def needs_rebase_onto_base(cwd: Path, base_ref: str, head_sha: str) -> bool:
    git_output(cwd, "fetch", "origin", base_ref)
    return not is_ancestor(cwd, f"origin/{base_ref}", head_sha)


def rebase_onto_base(cwd: Path, base_ref: str, branch: str, expected_head: str) -> str | None:
    git_output(cwd, "fetch", "origin", base_ref)
    hard_reset_work_root(cwd, expected_head)
    completed = subprocess.run(
        ["git", "rebase", f"origin/{base_ref}"],
        cwd=str(cwd),
        check=False,
        text=True,
        capture_output=True,
    )
    if completed.returncode != 0:
        subprocess.run(["git", "rebase", "--abort"], cwd=str(cwd), check=False, text=True, capture_output=True)
        return None
    new_head = git_output(cwd, "rev-parse", "HEAD").strip()
    safe_push(branch=branch, expected_head=expected_head, cwd=cwd)
    return new_head


def normalize_repair_commit(cwd: Path, start_head: str, end_head: str, check_name: str) -> str:
    if is_ancestor(cwd, start_head, end_head):
        return end_head
    diff = git_output(cwd, "diff", "--binary", start_head, end_head)
    hard_reset_work_root(cwd, start_head)
    if not diff.strip():
        return start_head
    with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False) as handle:
        handle.write(diff)
        patch_path = Path(handle.name)
    try:
        git_output(cwd, "apply", "--index", str(patch_path))
    finally:
        patch_path.unlink(missing_ok=True)
    if not git_lines(cwd, "status", "--porcelain"):
        return start_head
    git_output(cwd, "commit", "-m", f"Repair {check_name}")
    return git_output(cwd, "rev-parse", "HEAD").strip()


def validate_local_pr_body(cwd: Path, body: str, base_branch: str) -> dict[str, object]:
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
            cwd=str(cwd),
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


def validate_pr_body_from_current_diff(cwd: Path, body: str, base_branch: str) -> dict[str, object]:
    git_output(cwd, "fetch", "origin", f"+refs/heads/{base_branch}:refs/remotes/origin/{base_branch}")
    changed_files = git_output(cwd, "diff", "--name-only", f"origin/{base_branch}...HEAD")
    diff_text = git_output(cwd, "diff", "--no-ext-diff", f"origin/{base_branch}...HEAD")
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
            cwd=str(cwd),
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


def validate_current_pr_body(cwd: Path, body: str, base_branch: str) -> dict[str, object]:
    try:
        return validate_local_pr_body(cwd, body, base_branch)
    except RuntimeError:
        return validate_pr_body_from_current_diff(cwd, body, base_branch)


def is_proof_tooling_policy_validation(value: Mapping[str, object]) -> bool:
    errors = value.get("errors")
    scope_kinds = value.get("scopeKinds")
    review_units = value.get("reviewUnits")
    if value.get("reviewLane") != "proof" or value.get("reviewUnit") != "proof":
        return False
    if not isinstance(review_units, list):
        return False
    review_unit_set = {str(unit) for unit in review_units}
    if "tooling-policy" not in review_unit_set:
        return False
    if not review_unit_set.issubset({"proof", "tooling-policy"}):
        return False
    if not isinstance(scope_kinds, list):
        return False
    scope_kind_set = {str(kind) for kind in scope_kinds}
    if scope_kind_set and (
        "policy" not in scope_kind_set or not scope_kind_set.issubset({"policy", "product-test", "proof"})
    ):
        return False
    if not isinstance(errors, list):
        return False
    return bool(errors) and set(errors).issubset({PROOF_POLICY_LANE_ERROR, PROOF_TOOLING_POLICY_UNIT_ERROR})


def is_prereq_split_validation(value: Mapping[str, object], base_ref_name: str) -> bool:
    return base_ref_name == TRUNK and is_proof_tooling_policy_validation(value)


def is_manual_split_validation(value: Mapping[str, object]) -> bool:
    errors = value.get("errors")
    review_units = value.get("reviewUnits")
    if not isinstance(errors, list) or not errors:
        return False
    if not isinstance(review_units, list):
        return False
    if len({str(unit) for unit in review_units}) < 2:
        return False
    joined = "\n".join(str(error) for error in errors)
    return (
        "multiple review units" in joined
        or "Split this into one Review Unit per PR." in joined
        or "cannot ship with policy, proof files" in joined
        or "cannot ship with tooling-policy, proof files" in joined
        or "cannot ship with proof files" in joined
    )


def invalid_repair_errors(value: Mapping[str, object], base_ref_name: str) -> list[str]:
    errors = [str(error) for error in value.get("errors", [])]
    if is_proof_tooling_policy_validation(value) and base_ref_name != TRUNK:
        errors = [*errors, NON_TRUNK_PREREQ_ERROR]
    if is_manual_split_validation(value) and base_ref_name != TRUNK:
        errors = [*errors, NON_TRUNK_MANUAL_SPLIT_ERROR]
    return errors


def prerequisite_branch_name(pr_number: int, start_head: str) -> str:
    return f"stack/pr-babysit-prereq-{pr_number}-{start_head[:7]}"


def prerequisite_title(pr_number: int, check_name: str) -> str:
    return f"[PR babysit] Tooling-policy repair prerequisite for #{pr_number}: {check_name}"


def prerequisite_body(pr_number: int, check_name: str) -> str:
    return (
        "## Summary\n\n"
        "Worker-generated tooling-policy repair.\n\n"
        "## Review Claim\n\n"
        f"This PR carries the worker-generated tooling-policy repair that unblocks {check_name} on #{pr_number}.\n\n"
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


def create_repair_prerequisite(
    gh: GhClient,
    ledger: Ledger,
    logger: AdminBypassLogger,
    repo: str,
    cwd: Path,
    pr_number: int,
    head_sha: str,
    check_name: str,
    start_head: str,
    repair_commits: Sequence[str],
    now: int | None,
) -> dict[str, object]:
    branch_name = prerequisite_branch_name(pr_number, start_head)
    title = prerequisite_title(pr_number, check_name)
    body = prerequisite_body(pr_number, check_name)
    git_output(cwd, "checkout", "-B", branch_name, f"origin/{TRUNK}")
    git_output(cwd, "reset", "--hard", f"origin/{TRUNK}")
    for commit in repair_commits:
        git_output(cwd, "cherry-pick", commit)
    validation = validate_current_pr_body(cwd, body, TRUNK)
    if not validation.get("valid"):
        errors = [str(error) for error in validation.get("errors", [])]
        raise RuntimeError("prerequisite PR body failed validation: " + "; ".join(errors))
    safe_push(branch=branch_name, expect_missing=True, cwd=cwd)
    created = gh.create_pr(repo, title, body, branch_name, TRUNK)
    prereq_number = int(created.get("number") or 0)
    if prereq_number <= 0:
        raise RuntimeError("GitHub did not return a prerequisite PR number")
    gh.edit_label(repo, prereq_number, add="admin-bypass")
    ledger.record(
        "repair-prereq-created",
        pr_number,
        head_sha,
        check_name,
        now,
        meta={"prNumber": prereq_number, "branch": branch_name},
    )
    logger.trace(
        "admin-bypass-repair-prereq-created",
        repo=repo,
        pr_number=pr_number,
        check_name=check_name,
        prereq_pr_number=prereq_number,
        prereq_branch=branch_name,
        repair_commits=list(repair_commits),
    )
    return {"prNumber": prereq_number, "branch": branch_name, "title": title}

from __future__ import annotations

import json
import shlex
import tempfile
from pathlib import Path

try:
    from .mergify_admin_requeue_headless_shell import run_headless as _run_headless
except ImportError:
    from mergify_admin_requeue_headless_shell import run_headless as _run_headless


def resolve_workflow_for_pr(pr_number: int) -> str | None:
    # See cron-pr-lib.sh's resolve_workflow_for_pr comment: review-gate exits 0
    # with `{}` for a genuine miss (no local workflow mapping). A non-zero exit
    # means the lookup mechanism itself is broken, which must propagate as an
    # exception rather than silently falling back to ad-hoc repair.
    completed = _run_headless('headless_query query review-gate "$2" --output json', str(pr_number))
    if completed.returncode != 0:
        raise RuntimeError(
            f"resolve_workflow_for_pr failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )
    stdout = completed.stdout.strip()
    if not stdout:
        return None
    try:
        record = json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"resolve_workflow_for_pr produced invalid JSON for PR #{pr_number}: {stdout!r}") from exc
    if not isinstance(record, dict):
        raise RuntimeError(f"resolve_workflow_for_pr produced non-object JSON for PR #{pr_number}: {stdout!r}")
    workflow_id = record.get("workflowId")
    return str(workflow_id) if workflow_id else None


# Known accepted limitation: no debounce against re-submitting the fast-path
# mutation on every cron tick while a previous submission converges.


def submit_rebase_recreate(workflow_id: str) -> None:
    completed = _run_headless('headless_mutation --no-track rebase-recreate "$2"', workflow_id)
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_rebase_recreate failed for workflow {workflow_id}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )


def submit_repair_review_gate_ci(pr_number: int) -> None:
    completed = _run_headless('headless_mutation --no-track repair-review-gate-ci "$2"', str(pr_number))
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_repair_review_gate_ci failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )


def _close_pr_command_script(pr_number: int, repo: str, reason: str, expected_head_oid: str, kept_pr_number: int | None) -> str:
    # Belt-and-suspenders: the classification (landed/duplicate) already happened
    # in the scan loop, but this task may sit queued for a while before it runs,
    # so it re-checks the one fact that could invalidate the decision (this PR's
    # own state/headRefOid, and — for a duplicate close — that the PR being kept
    # is still open) immediately before mutating. Distinct exit codes make a
    # deliberate skip visible in the task's run history instead of reading as a
    # generic failure.
    lines = [
        "set -euo pipefail",
        f"num={pr_number}",
        f"repo={shlex.quote(repo)}",
        f"expected={shlex.quote(expected_head_oid)}",
        'current_json="$(gh pr view "$num" --repo "$repo" --json state,headRefOid)"',
        'current_state="$(printf \'%s\' "$current_json" | jq -r \'.state\')"',
        'current_head="$(printf \'%s\' "$current_json" | jq -r \'.headRefOid\')"',
        'if [ "$current_state" != "OPEN" ] || [ "$current_head" != "$expected" ]; then',
        '  echo "stale-pr: #$num is $current_state at $current_head; expected OPEN at $expected" >&2',
        "  exit 20",
        "fi",
    ]
    if kept_pr_number is not None:
        lines += [
            f"kept={kept_pr_number}",
            'kept_state="$(gh pr view "$kept" --repo "$repo" --json state --jq \'.state\')"',
            'if [ "$kept_state" != "OPEN" ]; then',
            '  echo "stale-kept-pr: kept PR #$kept is $kept_state, not OPEN; refusing to close #$num" >&2',
            "  exit 21",
            "fi",
        ]
    lines += [
        f"reason={shlex.quote(reason)}",
        'gh pr comment "$num" --repo "$repo" --body "Invoker duplicate-close: $reason"',
        'gh pr close "$num" --repo "$repo"',
        'echo "pr-duplicate-close: closed #$num ($reason)"',
    ]
    return "\n".join(lines)


def _close_pr_plan_yaml(pr_number: int, repo: str, reason: str, expected_head_oid: str, kept_pr_number: int | None) -> str:
    command_script = _close_pr_command_script(pr_number, repo, reason, expected_head_oid, kept_pr_number)
    indented_command = "\n".join(f"      {line}" if line else "" for line in command_script.splitlines())
    safe_reason = reason.replace('"', "'").replace("\n", " ")
    fingerprint_suffix = f"dup-{kept_pr_number}" if kept_pr_number is not None else "landed"
    return (
        f"name: close-pr-{pr_number}-{fingerprint_suffix}\n"
        "onFinish: none\n"
        "baseBranch: master\n"
        "tasks:\n"
        "  - id: close\n"
        f'    description: "Close PR #{pr_number}: {safe_reason}"\n'
        "    command: |\n"
        f"{indented_command}\n"
    )


def submit_close_pr(pr_number: int, repo: str, reason: str, expected_head_oid: str, kept_pr_number: int | None = None) -> None:
    plan_yaml = _close_pr_plan_yaml(pr_number, repo, reason, expected_head_oid, kept_pr_number)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=f"-close-pr-{pr_number}.yaml", delete=False, encoding="utf-8",
    ) as handle:
        handle.write(plan_yaml)
        plan_path = handle.name
    try:
        completed = _run_headless('headless_mutation run "$2"', plan_path)
    finally:
        Path(plan_path).unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_close_pr failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )

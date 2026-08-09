from __future__ import annotations

import json
import os
import shlex
import subprocess
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
    review_gate_cmd = os.environ.get("INVOKER_PR_CRON_REVIEW_GATE_CMD")
    if review_gate_cmd:
        completed = subprocess.run(
            [review_gate_cmd, str(pr_number)],
            text=True,
            capture_output=True,
            check=False,
        )
    else:
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


# Fast-path submissions are fire-and-forget: `--no-track` exit 0 means the
# owner ACCEPTED the mutation, not that the repair ran. Unlike repairer.py's
# ad-hoc repair plans (whose normalize task writes the `-settled` ledger row),
# a rebase-recreate of an existing workflow has no task that settles the
# ledger, so the planner could only infer the outcome by letting the 90-minute
# repair_in_flight TTL expire. These helpers close that gap by observing the
# workflow's actual terminal status and writing the settle row the plan
# machinery already understands (PR #7484, 2026-08-05: an accepted-but-starved
# recreate looked "handled" while its three predecessors had already failed).

_FASTPATH_SETTLE_KINDS = ("conflict-repair", "repair-check")
_TERMINAL_WORKFLOW_STATUSES = frozenset({"completed", "failed", "cancelled", "review_ready", "merged"})


def _parse_last_json_object(stdout: str) -> dict | None:
    text = stdout.strip()
    if not text:
        return None
    try:
        parsed = json.loads(text)
        return parsed if isinstance(parsed, dict) else None
    except json.JSONDecodeError:
        pass
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, dict):
            return parsed
    return None


def workflow_status(workflow_id: str) -> str | None:
    completed = _run_headless('headless_query query workflow "$2" --output json', workflow_id)
    if completed.returncode != 0:
        return None
    record = _parse_last_json_object(completed.stdout)
    if record is None:
        return None
    status = record.get("status")
    return str(status) if status else None


def settle_workflow_fastpath_rows(ledger, now: int) -> int:
    """Write `<kind>-settled` rows for fast-path submissions whose workflow
    reached a terminal status. Returns how many rows were settled. Rows whose
    workflow is still pending/running (or whose status cannot be read) are
    left alone; the existing repair_in_flight TTL stays as the backstop."""
    settled = 0
    for row in list(ledger.rows):
        kind = row.get("kind")
        if kind not in _FASTPATH_SETTLE_KINDS:
            continue
        meta = row.get("meta") or {}
        workflow_id = meta.get("workflowId")
        if not workflow_id:
            continue
        pr = int(row.get("pr", -1))
        head = str(row.get("headSha") or "")
        key = str(row.get("key") or "")
        existing = ledger.latest(f"{kind}-settled", pr, head, key)
        if existing is not None and int(existing.get("epoch", 0) or 0) >= int(row.get("epoch", 0) or 0):
            continue
        status = workflow_status(str(workflow_id))
        if status in _TERMINAL_WORKFLOW_STATUSES:
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta={"workflowId": str(workflow_id), "workflowStatus": status, "settledBy": "fastpath-observer"},
            )
            settled += 1
    return settled


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

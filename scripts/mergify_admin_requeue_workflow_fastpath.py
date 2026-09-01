from __future__ import annotations

import json
import os
import shlex
import subprocess
import tempfile
from pathlib import Path

try:
    from .mergify_admin_requeue_headless_shell import DEFAULT_TIMEOUT_SECONDS
    from .mergify_admin_requeue_headless_shell import run_headless as _run_headless
    from .mergify_admin_requeue_model import DEFAULT_INVOKER_REPO
    from .mergify_admin_requeue_async_repair import (
        rebase_onto_master_plan_name,
        repair_bot_thread_plan_name,
        repair_check_plan_name,
        repair_conflict_plan_name,
    )
except ImportError:
    from mergify_admin_requeue_headless_shell import DEFAULT_TIMEOUT_SECONDS
    from mergify_admin_requeue_headless_shell import run_headless as _run_headless
    from mergify_admin_requeue_model import DEFAULT_INVOKER_REPO
    from mergify_admin_requeue_async_repair import (
        rebase_onto_master_plan_name,
        repair_bot_thread_plan_name,
        repair_check_plan_name,
        repair_conflict_plan_name,
    )


def resolve_workflow_for_pr(pr_number: int, repo: str = DEFAULT_INVOKER_REPO) -> str | None:
    # See cron-pr-lib.sh's resolve_workflow_for_pr comment: review-gate exits 0
    # with `{}` for a genuine miss (no local workflow mapping). A non-zero exit
    # means the lookup mechanism itself is broken, which must propagate as an
    # exception rather than silently falling back to ad-hoc repair.
    #
    # Invoker only ever owns a workflow for a PR on its own repo -- a foreign
    # repo's PR number can collide with an unrelated Invoker PR number, so
    # skip the lookup entirely for any other repo instead of risking the
    # fast-path reusing the wrong repo's workflow.
    if repo != DEFAULT_INVOKER_REPO:
        return None
    review_gate_cmd = os.environ.get("INVOKER_PR_CRON_REVIEW_GATE_CMD")
    if review_gate_cmd:
        try:
            completed = subprocess.run(
                [review_gate_cmd, str(pr_number)],
                text=True,
                capture_output=True,
                check=False,
                timeout=DEFAULT_TIMEOUT_SECONDS,
            )
        except subprocess.TimeoutExpired:
            completed = subprocess.CompletedProcess(
                [review_gate_cmd, str(pr_number)],
                returncode=124,
                stdout="",
                stderr=f"timed out after {DEFAULT_TIMEOUT_SECONDS}s",
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

_FASTPATH_SETTLE_KINDS = ("conflict-repair", "rebase-onto-master", "repair-check")
_TERMINAL_WORKFLOW_STATUSES = frozenset({"completed", "failed", "cancelled", "review_ready", "merged"})
_SSH_INFRA_FAILURE_CLASSES = frozenset({
    "ssh-env-invalid-export",
    "ssh-worktree-missing",
    "ssh-invalid-reference",
    "ssh-repo-mirror-corrupt",
    "ssh-worktree-corrupt",
    "ssh-oauth-session-expired",
    "ssh-disk-full",
})
_OAUTH_INFRA_SIGNATURE = "Failed to authenticate: OAuth session expired and could not be refreshed"


def list_workflow_tasks(workflow_id: str) -> list[dict] | None:
    completed = _run_headless('headless_query query tasks "$2" --output json', workflow_id)
    if completed.returncode != 0:
        return None
    text = completed.stdout.strip()
    if not text:
        return None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("["):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            return [row for row in parsed if isinstance(row, dict)]
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return [row for row in parsed if isinstance(row, dict)] if isinstance(parsed, list) else None


def classify_repair_outcome(workflow_id: str, status: str) -> str:
    """Classify a terminal repair workflow for Mergify code-cap accounting.

    `infra` and `superseded` must not spend the code-repair attempt budget.
    Unknown/code failures still count so thrash cannot loop forever.
    Inspect tasks before treating `completed` as success — a merge-gate
    workflow can complete while safe-push failed with stale-head (PR #10278).
    """
    tasks = list_workflow_tasks(workflow_id) or []
    for task in tasks:
        execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
        failure_class = execution.get("failureClass")
        if isinstance(failure_class, str) and failure_class in _SSH_INFRA_FAILURE_CLASSES:
            return "infra"
        error = str(execution.get("error") or execution.get("pendingFixError") or "")
        if "stale-head" in error:
            return "superseded"
        if "fatal: not a git repository" in error and "/.git/worktrees/" in error:
            return "infra"
        if _OAUTH_INFRA_SIGNATURE in error:
            return "infra"
        if "No space left on device" in error:
            return "infra"
        if "/Users/" in error and ("PermissionError" in error or "Permission denied" in error):
            return "infra"
    if status == "completed":
        return "success"
    if status in _TERMINAL_WORKFLOW_STATUSES:
        return "code"
    return "unknown"


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
            outcome = classify_repair_outcome(str(workflow_id), status)
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta={
                    "workflowId": str(workflow_id),
                    "workflowStatus": status,
                    "outcomeClass": outcome,
                    "settledBy": "fastpath-observer",
                },
            )
            settled += 1
    return settled


def list_workflows() -> list[dict] | None:
    """List every known workflow. Used by settle_repairer_plan_rows, which
    (unlike settle_workflow_fastpath_rows) has no workflowId to look up
    directly and must find its match by name instead."""
    completed = _run_headless('headless_query query workflows --output json')
    if completed.returncode != 0:
        return None
    text = completed.stdout.strip()
    if not text:
        return None
    for line in reversed(text.splitlines()):
        line = line.strip()
        if not line.startswith("["):
            continue
        try:
            parsed = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            return parsed
    return None


# repairer.py's ad-hoc repair plans (repair-check, rebase-onto-master,
# repair-bot-thread; plus legacy conflict-repair) settle via their own plan's
# `safe-push` task, which only runs if the upstream `repair` task succeeds.
# When `repair` itself fails, `safe-push` never runs and the `-settled` row is
# never written -- the row repairer.py records before submission (see
# AdminBypassRepairer) carries no meta.workflowId, so
# settle_workflow_fastpath_rows's lookup can't find it either. Unlike a
# fast-path rebase-recreate, these plan names are fully deterministic from
# (pr, headSha, key) via the same *_plan_name() helpers used to build the plan,
# so the matching workflow can be found by name instead of by a recorded id
# (PR #9172: a failed repair-bot-thread attempt left `repair_in_flight`
# believing a repair was still running for the rest of its 90-minute TTL, even
# though the workflow had already failed).
_REPAIRER_PLAN_SETTLE_KINDS = ("repair-check", "conflict-repair", "rebase-onto-master", "repair-bot-thread")


def _repairer_plan_name(kind: str, pr: int, head: str, key: str) -> str:
    if kind == "repair-check":
        return repair_check_plan_name(pr, key, head)
    if kind == "conflict-repair":
        return repair_conflict_plan_name(pr, head)
    if kind == "rebase-onto-master":
        return rebase_onto_master_plan_name(pr, head)
    return repair_bot_thread_plan_name(pr, head)


def settle_repairer_plan_rows(ledger, now: int) -> int:
    """Reconcile pending requests, then settle acknowledged repair workflows."""
    pending_requests = [
        row for row in ledger.rows
        if str(row.get("kind") or "").endswith("-pending")
        and str(row.get("kind") or "").removesuffix("-pending") in _REPAIRER_PLAN_SETTLE_KINDS
    ]
    acknowledged = []
    for row in ledger.rows:
        kind = row.get("kind")
        if kind not in _REPAIRER_PLAN_SETTLE_KINDS:
            continue
        pr = int(row.get("pr", -1))
        head = str(row.get("headSha") or "")
        key = str(row.get("key") or "")
        existing = ledger.latest(f"{kind}-settled", pr, head, key)
        if existing is None or int(existing.get("epoch", 0) or 0) < int(row.get("epoch", 0) or 0):
            acknowledged.append(row)
    if not pending_requests and not acknowledged:
        return 0
    workflows = list_workflows()
    if workflows is None:
        return 0
    settled = 0
    for row in pending_requests:
        pending_kind = str(row.get("kind"))
        kind = pending_kind.removesuffix("-pending")
        pr = int(row.get("pr", -1))
        head = str(row.get("headSha") or "")
        key = str(row.get("key") or "")
        pending_epoch = int(row.get("epoch", 0) or 0)
        existing_ack = ledger.latest(kind, pr, head, key)
        if existing_ack is not None and int(existing_ack.get("epoch", 0) or 0) >= pending_epoch:
            continue
        existing_settle = ledger.latest(f"{pending_kind}-settled", pr, head, key)
        if existing_settle is not None and int(existing_settle.get("epoch", 0) or 0) >= pending_epoch:
            continue
        meta = row.get("meta") or {}
        plan_name = str(meta.get("planName") or _repairer_plan_name(kind, pr, head, key))
        match = next((workflow for workflow in workflows if workflow.get("name") == plan_name), None)
        if match is not None:
            ledger.record(
                kind,
                pr,
                head,
                key,
                now,
                meta={
                    "dispatchState": "acknowledged",
                    "acknowledgedBy": "pending-request-observer",
                    "planName": plan_name,
                    "workflowId": match.get("id"),
                },
            )
        else:
            ledger.record(
                f"{pending_kind}-settled",
                pr,
                head,
                key,
                now,
                meta={
                    "dispatchState": "not-acknowledged",
                    "failurePhase": "submission",
                    "outcomeClass": "infra",
                    "planName": plan_name,
                },
            )
        settled += 1
    for row in acknowledged:
        kind = str(row.get("kind"))
        pr = int(row.get("pr", -1))
        head = str(row.get("headSha") or "")
        key = str(row.get("key") or "")
        plan_name = _repairer_plan_name(kind, pr, head, key)
        match = next((w for w in workflows if w.get("name") == plan_name), None)
        if match is None:
            continue
        status = match.get("status")
        if status in _TERMINAL_WORKFLOW_STATUSES:
            workflow_id = str(match.get("id") or "")
            outcome = classify_repair_outcome(workflow_id, str(status)) if workflow_id else "unknown"
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta={
                    "workflowId": match.get("id"),
                    "workflowStatus": status,
                    "outcomeClass": outcome,
                    "settledBy": "repairer-plan-observer",
                },
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


def _flag_probable_duplicate_command_script(
    pr_number: int, repo: str, evidence: str, expected_head_oid: str, merged_pr_number: int,
) -> str:
    # Comment-only -- never closes. See plan_flag_probable_duplicates' own
    # docstring for why a modify/modify conflict can't be auto-resolved.
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
        f"merged={merged_pr_number}",
        f"evidence={shlex.quote(evidence)}",
        'gh pr comment "$num" --repo "$repo" --body "Invoker probable-duplicate flag: this PR looks like a duplicate of already-merged #$merged. $evidence Needs a human or agent to confirm the conflicting content is equivalent, then close as duplicate."',
        'echo "pr-duplicate-close: flagged #$num as probable duplicate of #$merged"',
    ]
    return "\n".join(lines)


def _flag_probable_duplicate_plan_yaml(
    pr_number: int, repo: str, evidence: str, expected_head_oid: str, merged_pr_number: int,
) -> str:
    command_script = _flag_probable_duplicate_command_script(pr_number, repo, evidence, expected_head_oid, merged_pr_number)
    indented_command = "\n".join(f"      {line}" if line else "" for line in command_script.splitlines())
    safe_evidence = evidence.replace('"', "'").replace("\n", " ")
    return (
        f"name: flag-duplicate-pr-{pr_number}-vs-{merged_pr_number}\n"
        "onFinish: none\n"
        "baseBranch: master\n"
        "tasks:\n"
        "  - id: flag\n"
        f'    description: "Flag PR #{pr_number} as a probable duplicate of #{merged_pr_number}: {safe_evidence}"\n'
        "    command: |\n"
        f"{indented_command}\n"
    )


def submit_flag_probable_duplicate(pr_number: int, repo: str, evidence: str, expected_head_oid: str, merged_pr_number: int) -> None:
    plan_yaml = _flag_probable_duplicate_plan_yaml(pr_number, repo, evidence, expected_head_oid, merged_pr_number)
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=f"-flag-duplicate-pr-{pr_number}.yaml", delete=False, encoding="utf-8",
    ) as handle:
        handle.write(plan_yaml)
        plan_path = handle.name
    try:
        completed = _run_headless('headless_mutation run "$2"', plan_path)
    finally:
        Path(plan_path).unlink(missing_ok=True)
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_flag_probable_duplicate failed for PR #{pr_number}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )

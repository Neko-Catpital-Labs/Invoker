from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import NamedTuple

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
    # Safety invariant: workflow lookup only runs for DEFAULT_INVOKER_REPO because PR numbers collide across repos.
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
        # Safety invariant: non-zero lookup is infrastructure failure and must not fall back to ad-hoc repair.
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


def submit_rebase_recreate(workflow_id: str) -> None:
    completed = _run_headless('headless_mutation --no-track rebase-recreate "$2"', workflow_id)
    if completed.returncode != 0:
        raise RuntimeError(
            f"submit_rebase_recreate failed for workflow {workflow_id}: "
            f"{completed.stderr.strip() or completed.stdout.strip()}"
        )


# Safety invariant: fast-path settlement observes terminal workflow status because --no-track only acknowledges submission.
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
_CAPACITY_DEFERRED_REASONS = frozenset({"resource-limit", "execution-pool-capacity", "ssh-resource-lease-held"})


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
            return _attach_task_events([row for row in parsed if isinstance(row, dict)])
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        return None
    return _attach_task_events([row for row in parsed if isinstance(row, dict)]) if isinstance(parsed, list) else None


def list_task_events(task_id: str) -> list[dict] | None:
    completed = _run_headless('headless_query query audit "$2" --output json', task_id)
    if completed.returncode != 0:
        return None
    text = completed.stdout.strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        parsed = None
        for line in reversed(text.splitlines()):
            try:
                candidate = json.loads(line.strip())
            except json.JSONDecodeError:
                continue
            if isinstance(candidate, list):
                parsed = candidate
                break
    return [row for row in parsed if isinstance(row, dict)] if isinstance(parsed, list) else None


def _attach_task_events(tasks: list[dict]) -> list[dict]:
    enriched = []
    for task in tasks:
        task_with_events = dict(task)
        task_with_events["events"] = list_task_events(str(task.get("id") or "")) or []
        task_with_events["_auditEventsLoaded"] = True
        enriched.append(task_with_events)
    return enriched


def _task_never_launched(task: dict) -> bool:
    execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
    return execution.get("phase") == "launching" and not execution.get("launchCompletedAt")


SAFE_PUSH_HEAD_UNCHANGED_EXIT_CODE = 21


class RepairOutcomeDetail(NamedTuple):
    outcome_class: str
    reason: str | None = None


def _is_safe_push_task(task: dict) -> bool:
    task_id = str(task.get("id") or "")
    return task_id.rsplit("/", 1)[-1] == "safe-push"


def classify_repair_outcome_detail(workflow_id: str, status: str) -> RepairOutcomeDetail:
    """Classify a terminal repair workflow for Mergify code-cap accounting.

    `infra`, `superseded`, and capacity-only deferrals must not spend the
    code-repair attempt budget. Executor selection takes precedence over an
    earlier capacity deferral because it proves the repair was admitted.
    Unknown/code failures still count so thrash cannot loop forever.
    Inspect tasks before treating `completed` as success — a merge-gate
    workflow can complete while safe-push failed with stale-head (PR #10278).

    A safe-push exit of 21 means the task checkout never moved (outcome
    `code`, reason `head-unchanged`). Any other non-zero safe-push exit that
    is not infra or stale-head is `code` with reason `push-failed`. Failed
    safe-push tasks must carry a numeric `execution.exitCode`; missing that
    field is a hard error so classification never falls back to phrase match.
    """
    tasks = list_workflow_tasks(workflow_id) or []
    admitted = False
    capacity_deferred = False
    for task in tasks:
        events = task.get("events", []) if task.get("_auditEventsLoaded") or "events" in task else []
        for event in events or []:
            event_type = event.get("eventType")
            payload = event.get("payload")
            if isinstance(payload, str):
                try:
                    payload = json.loads(payload)
                except json.JSONDecodeError:
                    payload = {}
            payload = payload if isinstance(payload, dict) else {}
            if event_type == "task.executor.selected":
                admitted = True
            elif event_type == "task.executor.deferred" and payload.get("reason") in _CAPACITY_DEFERRED_REASONS:
                capacity_deferred = True
    if capacity_deferred and not admitted:
        return RepairOutcomeDetail("capacity-deferred")
    for task in tasks:
        execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
        failure_class = execution.get("failureClass")
        if isinstance(failure_class, str) and (failure_class in _SSH_INFRA_FAILURE_CLASSES or failure_class == "agent-usage-limit"):
            return RepairOutcomeDetail("infra")
        error = str(execution.get("error") or execution.get("pendingFixError") or "")
        if "stale-head" in error:
            return RepairOutcomeDetail("superseded")
        if "fatal: not a git repository" in error and "/.git/worktrees/" in error:
            return RepairOutcomeDetail("infra")
        if _OAUTH_INFRA_SIGNATURE in error:
            return RepairOutcomeDetail("infra")
        if "No space left on device" in error:
            return RepairOutcomeDetail("infra")
        if "/Users/" in error and ("PermissionError" in error or "Permission denied" in error):
            return RepairOutcomeDetail("infra")
    failed_tasks = [task for task in tasks if task.get("status") == "failed"]
    if failed_tasks and all(_task_never_launched(task) for task in failed_tasks):
        return RepairOutcomeDetail("infra")
    for task in failed_tasks:
        if not _is_safe_push_task(task):
            continue
        execution = task.get("execution") if isinstance(task.get("execution"), dict) else {}
        if "exitCode" not in execution:
            raise RuntimeError(
                f"safe-push task {task.get('id')!r} on workflow {workflow_id!r} "
                "has no execution.exitCode; refuse to classify from error text"
            )
        exit_code = execution.get("exitCode")
        if exit_code == SAFE_PUSH_HEAD_UNCHANGED_EXIT_CODE:
            return RepairOutcomeDetail("code", "head-unchanged")
        if isinstance(exit_code, int) and exit_code != 0:
            return RepairOutcomeDetail("code", "push-failed")
    if status == "completed":
        return RepairOutcomeDetail("success")
    if status in _TERMINAL_WORKFLOW_STATUSES:
        return RepairOutcomeDetail("code")
    return RepairOutcomeDetail("unknown")


def classify_repair_outcome(workflow_id: str, status: str) -> str:
    return classify_repair_outcome_detail(workflow_id, status).outcome_class


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


def is_resolvable_workflow_id(value: object) -> bool:
    """True when `value` could name a real workflow.

    The app's own predicate is `/^wf-[^/]+$/`
    (persisted-workflow-mutation-coordinator.ts), and ids are not all numeric
    (`wf-stress-1`, `wf-hitch-fat`), so this stays deliberately loose. It only
    rejects what a capture bug produces: whitespace, an escape sequence, or a
    quote spliced in from the surrounding output.
    """
    if not isinstance(value, str) or not value.startswith("wf-") or len(value) <= 3:
        return False
    return not any(ch in value for ch in " \t\n\r\\\"'/")


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
        if not is_resolvable_workflow_id(workflow_id):
            # Safety invariant: unresolvable workflow IDs settle as infra non-acknowledgement instead of re-querying forever.
            print(
                f"WARN: settle_workflow_fastpath_rows: PR #{pr} {kind} {key!r} stored an "
                f"unresolvable workflowId {workflow_id!r}; settling it as an infra "
                f"non-acknowledgement instead of re-querying it.",
                file=sys.stderr,
            )
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta={
                    "workflowId": workflow_id,
                    "dispatchState": "not-acknowledged",
                    "failurePhase": "submission",
                    "outcomeClass": "infra",
                    "settledBy": "fastpath-observer",
                    "reason": "unresolvable-workflow-id",
                },
            )
            settled += 1
            continue
        status = workflow_status(str(workflow_id))
        if status in _TERMINAL_WORKFLOW_STATUSES:
            detail = classify_repair_outcome_detail(str(workflow_id), status)
            meta = {
                "workflowId": str(workflow_id),
                "workflowStatus": status,
                "outcomeClass": detail.outcome_class,
                "settledBy": "fastpath-observer",
            }
            if detail.reason is not None:
                meta["reason"] = detail.reason
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta=meta,
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


# Safety invariant: repairer plan rows without workflowId settle by deterministic plan name when failed repairs skip safe-push.
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
            detail = (
                classify_repair_outcome_detail(workflow_id, str(status))
                if workflow_id
                else RepairOutcomeDetail("unknown")
            )
            meta = {
                "workflowId": match.get("id"),
                "workflowStatus": status,
                "outcomeClass": detail.outcome_class,
                "settledBy": "repairer-plan-observer",
            }
            if detail.reason is not None:
                meta["reason"] = detail.reason
            ledger.record(
                f"{kind}-settled", pr, head, key, now,
                meta=meta,
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
    # Safety invariant: duplicate-close commands re-read state and head before mutating because queued decisions can go stale.
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
        "mergeMode: no_op\n"
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
    # Safety invariant: probable duplicate plans only comment because modify/modify conflicts require human confirmation.
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
        "mergeMode: no_op\n"
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

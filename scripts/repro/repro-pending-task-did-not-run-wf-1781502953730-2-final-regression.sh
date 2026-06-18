#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="wf-1781502953730-2/final-regression"
log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1781502953730-2-final-regression.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1781502953730-2-final-regression-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: stale running SSH work was filtered out of pending investigation when an active selected-attempt SSH lease existed"
echo "[repro] diagnostic: the task did launch, then stopped making heartbeat/progress while the retry loop deferred investigation"

python3 <<'PY'
import datetime as dt

task_id = "wf-1781502953730-2/final-regression"
task = {
    "id": task_id,
    "status": "running",
    "config": {
        "workflowId": "wf-1781502953730-2",
        "runnerKind": "ssh",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_4",
    },
    "execution": {
        "selectedAttemptId": f"{task_id}-a48f877a2",
        "phase": "executing",
        "launchStartedAt": "2026-06-16T00:51:33.162Z",
        "launchCompletedAt": "2026-06-16T00:52:13.351Z",
        "startedAt": "2026-06-16T00:52:13.351Z",
        "lastHeartbeatAt": "2026-06-16T00:53:43.150Z",
    },
}
queue = {
    "running": [{"taskId": task_id, "attemptId": f"{task_id}-a48f877a2"}],
    "queued": [{"taskId": "wf-1781504329764-9/final-config-metadata-regression"}],
    "runningCount": 1,
    "maxConcurrency": 12,
}
audit_events = {
    "task.launch_claimed",
    "task.launch_dispatch_enqueued",
    "task.launch_dispatch_claimed",
    "task.executor.start_begin",
    "task.running",
    "task.executor.selected",
}
active_selected_attempt_ssh_lease = True

def parse_z(value: str) -> dt.datetime:
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))

now = parse_z("2026-06-16T01:03:45.000Z")
last_heartbeat = parse_z(task["execution"]["lastHeartbeatAt"])
stale_after_seconds = 300
is_stale_running = (
    task["status"] == "running"
    and task["id"] in {item["taskId"] for item in queue["running"]}
    and (now - last_heartbeat).total_seconds() >= stale_after_seconds
)

assert task["execution"]["phase"] == "executing"
assert {"task.running", "task.executor.selected"} <= audit_events
assert is_stale_running
assert active_selected_attempt_ssh_lease

stale_investigation = {task_id}
pool_capacity_blocked = set()
ssh_running_active_lease = {task_id}

pre_fix = (stale_investigation - pool_capacity_blocked) - ssh_running_active_lease
post_fix = stale_investigation - pool_capacity_blocked

assert pre_fix == set(), "pre-fix filter should suppress the stale running task"
assert post_fix == {task_id}, "post-fix logic should investigate the stale running task"

print("[repro] pre-fix: active selected-attempt SSH lease filtered the stale running task out, leaving no investigation target")
print("[repro] post-fix: active selected-attempt SSH lease is diagnostic only; stale running task remains investigation target")
PY

python3 - "$ROOT" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
script = (root / "scripts/retry-pending-autofix-failed.sh").read_text(encoding="utf-8")

removed = "stale-investigation-active-lease-filtered"
bad_message = "pending investigation excludes running SSH tasks with active leases"
good_message = "pending investigation includes running SSH tasks with active leases"

assert removed not in script, "old active-lease stale-investigation filter is still present"
assert bad_message not in script, "old deferral/exclusion message is still present"
assert good_message in script, "patched diagnostic inclusion message is missing"

print("[repro] patched script no longer filters active-lease stale running tasks out of investigation")
PY

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: stale running SSH task with active selected-attempt lease is investigated" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"

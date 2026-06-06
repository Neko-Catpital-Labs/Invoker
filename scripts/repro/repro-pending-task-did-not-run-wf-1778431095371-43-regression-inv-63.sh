#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-pool-deferral-repro.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-pool-deferral-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] wf-1778431095371-43/regression-inv-63 was pending because pnpm-ssh launch attempts were repeatedly deferred by SSH resource leases / pool capacity."
echo "[repro] After each deferral, deferTask clears launch timestamps and leaves the task pending in the queue."
echo "[repro] Before the fix, retry-pending-autofix-failed treated that queue-active no-timestamp shape as stale and launched Codex investigation."
echo "[repro] After the fix, the retry loop treats that shape as an active blocker and waits for capacity instead."

python3 <<'PY'
import json

task = {
    "id": "wf-1778431095371-43/regression-inv-63",
    "createdAt": "2026-06-03T18:00:00.000Z",
    "status": "pending",
    "config": {"poolId": "pnpm-ssh", "runnerKind": "ssh"},
    "execution": {},
}
queue = {
    "queued": [{"taskId": "wf-1778431095371-43/regression-inv-63"}],
    "running": [],
    "runningCount": 0,
}
audit = [
    {
        "eventType": "task.executor.deferred",
        "payload": json.dumps({"reason": "ssh-resource-lease-held", "poolId": "pnpm-ssh"}),
    },
    {
        "eventType": "task.executor.deferred",
        "payload": json.dumps({"reason": "execution-pool-capacity", "poolId": "pnpm-ssh"}),
    },
    {
        "eventType": "task.deferred",
        "payload": json.dumps({"status": "pending", "execution": {}}),
    },
]

task_id = task["id"]
queued_ids = {row.get("taskId") for row in queue["queued"]}
defer_reasons = {
    json.loads(row["payload"]).get("reason")
    for row in audit
    if row["eventType"] == "task.executor.deferred"
}
assert task["status"] == "pending"
assert not task["execution"].get("launchStartedAt")
assert task_id in queued_ids
assert task["config"]["poolId"] == "pnpm-ssh"
assert {"ssh-resource-lease-held", "execution-pool-capacity"} <= defer_reasons

# Pre-fix retry loop logic treated old queued tasks with no launch metadata as
# stale, so it selected this capacity-deferred task for local Codex
# investigation. The fixed classifier first honors the active queue state and
# only considers launch/heartbeat timestamps for queue-active staleness.
old_classifier_would_investigate = (
    task["status"] == "pending"
    and not task["execution"].get("launchStartedAt")
    and bool(task.get("createdAt"))
)
fixed_classifier_blocks = (
    task["status"] == "pending"
    and task_id in queued_ids
    and not task["execution"].get("launchStartedAt")
)
assert old_classifier_would_investigate
assert fixed_classifier_blocks
print("[repro] diagnostic fixture asserts queued pending task plus pnpm-ssh lease/capacity deferrals")
print("[repro] pre-fix classifier would investigate; fixed classifier blocks on active queue")
PY

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: queue-active pending task after pool deferral is treated as blocker" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"

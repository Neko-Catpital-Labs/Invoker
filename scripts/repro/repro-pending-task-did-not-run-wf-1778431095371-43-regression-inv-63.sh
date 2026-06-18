#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-pool-deferral-repro.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-pool-deferral-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] wf-1778431095371-43/regression-inv-63 first waited on pnpm-ssh capacity, then claimed an SSH member and emitted task.executor.start_begin."
echo "[repro] The retry loop escalated it while it was still pending/launching inside TaskRunner's executor.start timeout window."
echo "[repro] Before the fix, the generic 300s active-queue threshold classified that launch as stale."
echo "[repro] After the fix, pending/launching queue-active tasks use executor-start-timeout + grace before investigation."

python3 <<'PY'
import json

task = {
    "id": "wf-1778431095371-43/regression-inv-63",
    "status": "pending",
    "config": {"poolId": "pnpm-ssh", "runnerKind": "ssh", "workflowId": "wf-1778431095371-43"},
    "execution": {
        "selectedAttemptId": "wf-1778431095371-43/regression-inv-63-a751c1263",
        "phase": "launching",
        "launchStartedAt": "2026-06-16T01:55:15.229Z",
        "lastHeartbeatAt": "2026-06-16T01:55:15.229Z",
    },
}
queue = {
    "queued": [],
    "running": [
        {
            "taskId": "wf-1778431095371-43/regression-inv-63",
            "attemptId": "wf-1778431095371-43/regression-inv-63-a751c1263",
        }
    ],
    "runningCount": 1,
}
audit = [
    {
        "eventType": "task.executor.deferred",
        "payload": json.dumps({"reason": "execution-pool-capacity", "poolId": "pnpm-ssh"}),
    },
    {
        "eventType": "task.executor.start_begin",
        "payload": json.dumps(
            {
                "attemptId": "wf-1778431095371-43/regression-inv-63-a751c1263",
                "executorType": "ssh",
                "poolId": "pnpm-ssh",
                "poolMemberId": "remote_digital_ocean_3",
            }
        ),
    },
]
resource_lease = {
    "taskId": task["id"],
    "holderId": "owner:22521:wf-1778431095371-43/regression-inv-63:wf-1778431095371-43/regression-inv-63-a751c1263",
    "poolMemberId": "remote_digital_ocean_3",
    "leaseExpiresAt": "2026-06-16T02:15:23.322Z",
}

task_id = task["id"]
queue_ids = {row.get("taskId") for row in queue["queued"]} | {row.get("taskId") for row in queue["running"]}
defer_reasons = {
    json.loads(row["payload"]).get("reason")
    for row in audit
    if row["eventType"] == "task.executor.deferred"
}
assert task["status"] == "pending"
assert task["execution"].get("phase") == "launching"
assert task["execution"].get("launchStartedAt")
assert task_id in queue_ids
assert task["config"]["poolId"] == "pnpm-ssh"
assert "execution-pool-capacity" in defer_reasons
assert any(row["eventType"] == "task.executor.start_begin" for row in audit)
assert resource_lease["taskId"] == task_id
assert resource_lease["holderId"].endswith(task["execution"]["selectedAttemptId"])

# At the time the retry loop escalated, the launch was roughly nine minutes old:
# older than the old generic 300s active-queue threshold, but younger than the
# fixed 600s executor start timeout plus 120s grace.
launch_age_seconds = 540
old_classifier_would_investigate = (
    task["status"] == "pending"
    and task_id in queue_ids
    and task["execution"].get("phase") == "launching"
    and launch_age_seconds >= 300
)
fixed_classifier_blocks = (
    task["status"] == "pending"
    and task_id in queue_ids
    and task["execution"].get("phase") == "launching"
    and launch_age_seconds < (600 + 120)
)
assert old_classifier_would_investigate
assert fixed_classifier_blocks
print("[repro] diagnostic fixture asserts queue-running pending/launching SSH task with start_begin and active selected-attempt lease")
print("[repro] pre-fix 300s classifier would investigate; fixed classifier waits for executor timeout plus grace")
PY

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: launch-active pending task before executor timeout is treated as blocker" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"

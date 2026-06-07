#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] wf-1778431099248-47/verify-secondary-hotspots-lanes was not blocked by dependencies."
echo "[repro] Its SSH launch dispatch lease expired while executor.start was still in progress."
echo "[repro] The expired dispatch was reaped/released, allowing duplicate launch work that later deferred the live attempt back to pending."

python3 <<'PY'
from datetime import datetime, timezone

TASK_ID = "wf-1778431099248-47/verify-secondary-hotspots-lanes"

task = {
    "id": TASK_ID,
    "status": "pending",
    "config": {
        "command": "cd packages/app && pnpm test -- src/__tests__/headless-delegation.test.ts",
        "executionAgent": "codex",
        "poolId": "pnpm-ssh",
        "runnerKind": "ssh",
        "workflowId": "wf-1778431099248-47",
    },
    "dependencies": [
        "wf-1778431099248-47/extract-headless-command-families",
        "wf-1778431099248-47/extract-task-runner-phases",
        "wf-1778431099248-47/extract-sqlite-adapter-slices",
    ],
    "execution": {"lastHeartbeatAt": "2026-06-04T23:46:35.680Z"},
}

dependency_status = {
    "wf-1778431099248-47/extract-headless-command-families": "completed",
    "wf-1778431099248-47/extract-task-runner-phases": "completed",
    "wf-1778431099248-47/extract-sqlite-adapter-slices": "completed",
}
queue = {
    "queued": [{"taskId": TASK_ID}],
    "runningCount": 3,
    "maxConcurrency": 12,
}

events = [
    ("2026-06-04T23:40:03.457Z", "task.launch_claimed", {"dispatchId": 4399, "attemptId": f"{TASK_ID}-a5daa1eb0"}),
    ("2026-06-04T23:40:33.000Z", "task.launch_dispatch_reaped", {"dispatchId": 4399, "attemptsCount": 1, "reason": "lease_expired"}),
    ("2026-06-04T23:41:03.000Z", "task.launch_dispatch_reaped", {"dispatchId": 4399, "attemptsCount": 2, "reason": "lease_expired"}),
    ("2026-06-04T23:41:05.600Z", "task.running", {"attemptId": f"{TASK_ID}-a5daa1eb0"}),
    ("2026-06-04T23:41:15.219Z", "task.executor.deferred", {"reason": "ssh-resource-lease-held", "poolId": "pnpm-ssh"}),
    ("2026-06-04T23:41:15.219Z", "task.executor.deferred", {"reason": "execution-pool-capacity", "poolId": "pnpm-ssh"}),
    ("2026-06-04T23:41:15.219Z", "task.deferred", {"status": "pending"}),
]

assert task["status"] == "pending"
assert all(dependency_status[dependency] == "completed" for dependency in task["dependencies"])
assert TASK_ID in {row["taskId"] for row in queue["queued"]}
assert queue["runningCount"] < queue["maxConcurrency"]

def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

claim_time = ts(events[0][0])
first_reap_time = ts(events[1][0])
running_time = ts(events[3][0])
deferred_time = ts(events[6][0])

assert events[0][1] == "task.launch_claimed"
assert events[1][1] == "task.launch_dispatch_reaped"
assert events[1][2]["reason"] == "lease_expired"
assert events[2][1] == "task.launch_dispatch_reaped"
assert events[3][1] == "task.running"
assert events[4][2]["reason"] == "ssh-resource-lease-held"
assert events[5][2]["reason"] == "execution-pool-capacity"
assert events[6][1] == "task.deferred"

assert (first_reap_time - claim_time).total_seconds() <= 31
assert running_time > first_reap_time
assert deferred_time > running_time

print("[repro] pre-fix evidence: dispatch 4399 was reaped for lease_expired before executor.start completed.")
print("[repro] pre-fix impact: duplicate launch work then hit pnpm-ssh capacity and reset the live task to pending.")
PY

echo "[repro] Prove the fix: the fixed dispatch TTL survives normal executor startup and still reaps after expiry."
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/launch-dispatcher.test.ts \
  -t "uses a fixed dispatch TTL long enough for normal executor startup"

echo "[repro] Prove TaskRunner records where launch startup reached."
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  -t "logs executor start begin with launch-dispatch context while executor.start is pending"

echo "[repro] passed"

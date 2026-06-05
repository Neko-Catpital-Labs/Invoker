#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[repro] wf-1778825464672-5/final-regression-ui-bundle-splitting was launch-ready."
echo "[repro] Its SSH launch dispatch lease expired while executor.start was still provisioning."
echo "[repro] The expired dispatch was reaped, allowing duplicate launch work for the same attempt."

python3 <<'PY'
from datetime import datetime, timezone

TASK_ID = "wf-1778825464672-5/final-regression-ui-bundle-splitting"

task = {
    "id": TASK_ID,
    "status": "running",
    "config": {
        "command": "pnpm run test:all",
        "executionAgent": "codex",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_4",
        "runnerKind": "ssh",
        "workflowId": "wf-1778825464672-5",
    },
    "dependencies": [
        "wf-1778825464672-5/add-ui-bundle-repro-script",
        "wf-1778825464672-5/implement-ui-bundle-splitting",
        "wf-1778825464672-5/verify-ui-bundle-splitting",
    ],
    "execution": {
        "phase": "executing",
        "launchStartedAt": "2026-06-05T00:16:18.934Z",
        "launchCompletedAt": "2026-06-05T00:16:51.877Z",
        "startedAt": "2026-06-05T00:16:51.877Z",
        "lastHeartbeatAt": "2026-06-05T00:58:09.671Z",
    },
}

dependency_status = {
    "wf-1778825464672-5/add-ui-bundle-repro-script": "completed",
    "wf-1778825464672-5/implement-ui-bundle-splitting": "completed",
    "wf-1778825464672-5/verify-ui-bundle-splitting": "completed",
}

queue = {
    "maxConcurrency": 12,
    "running": [
        {"taskId": "wf-1780386838237-8/run-full-regression"},
        {"taskId": "wf-1780385813241-5/capture-after-visual-proof"},
        {"taskId": TASK_ID},
    ],
}

events = [
    (
        "2026-06-04T23:29:07.157Z",
        "task.launch_claimed",
        {
            "dispatchId": 4330,
            "attemptId": f"{TASK_ID}-a29d3967a",
            "generation": 219,
            "phase": "launching",
        },
    ),
    (
        "2026-06-04T23:29:37.000Z",
        "task.launch_dispatch_reaped",
        {
            "dispatchId": 4330,
            "attemptId": f"{TASK_ID}-a29d3967a",
            "attemptsCount": 1,
            "reason": "lease_expired",
        },
    ),
    (
        "2026-06-04T23:29:38.419Z",
        "task.running",
        {
            "attemptId": f"{TASK_ID}-a29d3967a",
            "generation": 219,
        },
    ),
    (
        "2026-06-04T23:29:38.419Z",
        "task.executor.selected",
        {
            "attemptId": f"{TASK_ID}-a29d3967a",
            "poolMemberId": "remote_digital_ocean_3",
        },
    ),
    (
        "2026-06-04T23:29:47.000Z",
        "task.executor.deferred",
        {
            "reason": "ssh-resource-lease-held",
            "poolId": "pnpm-ssh",
            "poolMemberId": "remote_digital_ocean_3",
        },
    ),
    (
        "2026-06-04T23:33:35.889Z",
        "task.running",
        {
            "attemptId": f"{TASK_ID}-af29c7b98",
            "generation": 221,
        },
    ),
    (
        "2026-06-04T23:33:38.171Z",
        "task.executor.deferred",
        {
            "reason": "ssh-resource-lease-held",
            "poolId": "pnpm-ssh",
            "poolMemberId": "remote_digital_ocean_4",
        },
    ),
    (
        "2026-06-04T23:33:38.171Z",
        "task.executor.deferred",
        {
            "reason": "execution-pool-capacity",
            "poolId": "pnpm-ssh",
            "excludedMemberKeys": ["ssh:remote_digital_ocean_4"],
        },
    ),
    (
        "2026-06-04T23:33:38.171Z",
        "task.execution_resource_lease_released",
        {
            "reason": "task deferred",
            "resourceKey": "ssh:invoker@138.68.230.225:22",
        },
    ),
    (
        "2026-06-04T23:33:38.171Z",
        "task.deferred",
        {"status": "pending"},
    ),
]

assert task["status"] == "running"
assert task["execution"]["phase"] == "executing"
assert all(dependency_status[dependency] == "completed" for dependency in task["dependencies"])
assert TASK_ID in {row["taskId"] for row in queue["running"]}
assert len(queue["running"]) < queue["maxConcurrency"]

def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

claim_time = ts(events[0][0])
reap_time = ts(events[1][0])
running_time = ts(events[2][0])
duplicate_defer_time = ts(events[6][0])

assert events[0][1] == "task.launch_claimed"
assert events[1][1] == "task.launch_dispatch_reaped"
assert events[1][2]["reason"] == "lease_expired"
assert events[2][1] == "task.running"
assert events[4][2]["reason"] == "ssh-resource-lease-held"
assert events[6][2]["reason"] == "ssh-resource-lease-held"
assert events[7][2]["reason"] == "execution-pool-capacity"
assert events[8][2]["reason"] == "task deferred"
assert events[9][1] == "task.deferred"

assert (reap_time - claim_time).total_seconds() <= 31
assert running_time > reap_time, "executor.start returned only after the dispatch lease was already reaped"
assert duplicate_defer_time > running_time, "duplicate launch work deferred an already-running attempt"

print("[repro] pre-fix evidence: dispatch 4330 was reaped for lease_expired before executor.start completed.")
print("[repro] pre-fix impact: duplicate launch work hit pnpm-ssh lease/capacity and reset live launch progress.")
PY

echo "[repro] Prove the fix: a slow in-flight launch dispatch is reaped without renewal, then survives after renewal."
pnpm --filter @invoker/app exec vitest run \
  src/__tests__/launch-dispatcher.test.ts \
  -t "renewDispatch keeps a slow in-flight launch from being reaped"

echo "[repro] Prove TaskRunner applies the fix during executor.start."
pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  -t "renews the dispatch lease while executor.start is still pending"

echo "[repro] passed"

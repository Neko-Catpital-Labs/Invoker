#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="wf-1778431088547-35/post-fix-regression"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1778431088547-35-post-fix-regression.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-wf-1778431088547-35-post-fix-regression-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: retry diagnostics only treated queued pool-deferred tasks as capacity-blocked."
echo "[repro] incident shape: the task was pending/launching while the launch queue reported it as running."

python3 <<'PY'
TASK_ID = "wf-1778431088547-35/post-fix-regression"

task = {
    "id": TASK_ID,
    "status": "pending",
    "config": {
        "workflowId": "wf-1778431088547-35",
        "runnerKind": "ssh",
        "poolId": "pnpm-ssh",
    },
    "execution": {
        "selectedAttemptId": f"{TASK_ID}-a872c8a71",
        "generation": 344,
        "lastHeartbeatAt": "2026-06-16T00:13:54.879Z",
        "launchStartedAt": "2026-06-16T00:13:54.879Z",
        "phase": "launching",
    },
}
queue = {
    "maxConcurrency": 12,
    "queued": [
        {"taskId": "wf-1781538160448-3/final-regression"},
    ],
    "running": [
        {"taskId": "wf-1781537045250-2/full-regression-gate"},
        {"taskId": "wf-1781537018656-1/verify-full-regression-suite"},
        {"taskId": "wf-1781504329764-9/final-config-metadata-regression"},
        {"taskId": "wf-1781502953730-2/final-regression"},
        {"taskId": "wf-1781280758906-1/final-regression"},
        {"taskId": "wf-1780400308114-1/regression-detached-lineage-ui-full-suite"},
        {"taskId": "wf-1779677388974-1/capture-after-visual-proof"},
        {"taskId": "wf-1778583393593-12/final-regression"},
        {"taskId": "wf-1778431102612-52/regression-inv-143"},
        {"taskId": "wf-1778431101284-50/regression-inv-155"},
        {"taskId": "wf-1778431095371-43/regression-inv-63"},
        {"taskId": TASK_ID, "attemptId": f"{TASK_ID}-a872c8a71"},
    ],
    "runningCount": 12,
}
audit_reasons = {"ssh-resource-lease-held", "execution-pool-capacity"}

def collect_queue_task_ids(value, output):
    if isinstance(value, dict):
        task_id = value.get("taskId") or value.get("id")
        if task_id:
            output.add(str(task_id))
        for nested in value.values():
            if isinstance(nested, (dict, list)):
                collect_queue_task_ids(nested, output)
    elif isinstance(value, list):
        for item in value:
            collect_queue_task_ids(item, output)

pre_fix_active_queue_task_ids = set()
collect_queue_task_ids(queue.get("queued"), pre_fix_active_queue_task_ids)

fixed_active_queue_task_ids = set()
collect_queue_task_ids(queue.get("running"), fixed_active_queue_task_ids)
collect_queue_task_ids(queue.get("queued"), fixed_active_queue_task_ids)

is_stale_pending_launch = (
    task["status"] == "pending"
    and task["execution"].get("phase") == "launching"
    and bool(task["execution"].get("launchStartedAt"))
)
has_pool_capacity_defer = bool(
    {"ssh-resource-lease-held", "execution-pool-capacity"} <= audit_reasons
)

pre_fix_would_investigate = (
    is_stale_pending_launch
    and TASK_ID not in pre_fix_active_queue_task_ids
)
fixed_blocks_on_pool_capacity = (
    is_stale_pending_launch
    and TASK_ID in fixed_active_queue_task_ids
    and task["config"].get("poolId") == "pnpm-ssh"
    and has_pool_capacity_defer
)

assert pre_fix_would_investigate
assert fixed_blocks_on_pool_capacity

print("[repro] pre-fix: queue.running was ignored, so the stale pending launch reached Codex investigation")
print("[repro] post-fix: queue.running is counted as active queue work and pool-capacity deferral blocks investigation")
print("[repro] diagnostic: ssh-resource-lease-held + execution-pool-capacity means launch waited for pnpm-ssh capacity")
PY

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: queue-running pool-capacity deferred task blocks stale pending investigation" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"

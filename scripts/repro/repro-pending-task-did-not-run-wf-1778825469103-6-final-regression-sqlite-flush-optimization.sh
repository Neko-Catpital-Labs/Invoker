#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_PATH="${INVOKER_DB_PATH:-${HOME:-.}/.invoker/invoker.db}"
TASK_ID="wf-1778825469103-6/final-regression-sqlite-flush-optimization"

log_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-final-regression-repro.XXXXXX.log")"
state_file="$(mktemp "${TMPDIR:-/tmp}/invoker-pending-final-regression-state.XXXXXX.tsv")"
trap 'rm -f "$log_file" "$state_file"' EXIT

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: the first launch was actively deferred by SSH pool leases/capacity, but retry diagnostics treated queued pending work as a no-launch task to investigate."
echo "[repro] fixed behavior: active SSH pool-capacity blockers are excluded from pending investigation, while truly running SSH tasks without active leases are investigated."

python3 - "$ROOT" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
script = (root / "scripts/retry-pending-autofix-failed.sh").read_text(encoding="utf-8")

task_id = "wf-1778825469103-6/final-regression-sqlite-flush-optimization"
first_attempt = f"{task_id}-a9ac56d13"

task = {
    "id": task_id,
    "status": "pending",
    "config": {
        "workflowId": "wf-1778825469103-6",
        "runnerKind": "ssh",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_3",
    },
    "execution": {
        "selectedAttemptId": first_attempt,
        "generation": 203,
        "lastHeartbeatAt": "2026-06-05T06:09:06.636Z",
        "phase": "launching",
        "launchStartedAt": "2026-06-05T06:09:06.636Z",
    },
}
queue = {
    "queued": [{"taskId": task_id}],
    "running": [],
    "runningCount": 0,
    "maxConcurrency": 12,
}
audit = [
    ("task.launch_claimed", {"attemptId": first_attempt, "generation": 203}),
    ("task.dispatch_enqueued", {"dispatchId": 4991, "attemptId": first_attempt}),
    ("task.executor.deferred", {
        "reason": "ssh-resource-lease-held",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_3",
        "resourceKey": "ssh:invoker@165.22.161.97:22",
    }),
    ("task.executor.deferred", {
        "reason": "ssh-resource-lease-held",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_4",
        "resourceKey": "ssh:invoker@138.68.230.225:22",
    }),
    ("task.executor.deferred", {
        "reason": "execution-pool-capacity",
        "poolId": "pnpm-ssh",
        "excludedMemberKeys": ["ssh:remote_digital_ocean_3", "ssh:remote_digital_ocean_4"],
    }),
    ("task.launch_dispatch_invalidated", {"dispatchId": 4991, "reason": "task deferred"}),
    ("task.deferred", {"status": "pending", "execution": {}}),
]

queued_ids = {entry["taskId"] for entry in queue["queued"]}
defer_reasons = {
    payload.get("reason")
    for event_type, payload in audit
    if event_type == "task.executor.deferred"
}

assert task["status"] == "pending"
assert task_id in queued_ids
assert task["config"]["runnerKind"] == "ssh"
assert task["config"]["poolId"] == "pnpm-ssh"
assert {"ssh-resource-lease-held", "execution-pool-capacity"} <= defer_reasons

pre_fix_would_investigate = (
    task["status"] == "pending"
    and task_id in queued_ids
    and bool(task["execution"].get("lastHeartbeatAt"))
)
fixed_classifier_blocks_on_capacity = (
    task["status"] == "pending"
    and task_id in queued_ids
    and task["config"].get("poolId") == "pnpm-ssh"
    and "execution-pool-capacity" in defer_reasons
)
assert pre_fix_would_investigate
assert fixed_classifier_blocks_on_capacity

required_source = [
    "write_pool_capacity_blocked_file",
    "pool-capacity-blocked=",
    "pending investigation excludes active SSH pool capacity blockers",
    "pending investigation deferred (pool capacity blockers remain:",
    "write_ssh_running_without_lease_file",
    "pending investigation includes SSH running tasks without active leases",
]
missing = [needle for needle in required_source if needle not in script]
if missing:
    raise SystemExit("fixed retry diagnostics are missing: " + ", ".join(missing))

print("[repro] fixture asserts the target's first launch was blocked by SSH pool leases/capacity")
print("[repro] pre-fix classifier would escalate the queued pending task as no-launch work")
print("[repro] fixed classifier defers investigation while active pool capacity blockers remain")
PY

if [ -f "$DB_PATH" ]; then
  python3 - "$DB_PATH" "$TASK_ID" <<'PY'
import json
import pathlib
import sqlite3
import sys

db_path = pathlib.Path(sys.argv[1]).expanduser()
task_id = sys.argv[2]
conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
conn.row_factory = sqlite3.Row
try:
    task = conn.execute(
        """
        SELECT id, status, runner_kind, pool_id, pool_member_id, selected_attempt_id,
               launch_phase, launch_started_at, launch_completed_at, started_at,
               last_heartbeat_at, workspace_path, branch
          FROM tasks
         WHERE id = ?
        """,
        (task_id,),
    ).fetchone()
    if task is None:
        print("[repro] local DB diagnostic: target task is no longer present")
        raise SystemExit(0)

    active_leases = conn.execute(
        """
        SELECT resource_key, holder_id, pool_member_id, lease_expires_at
          FROM execution_resource_leases
         WHERE task_id = ?
           AND resource_type = 'ssh'
           AND lease_expires_at IS NOT NULL
           AND julianday(lease_expires_at) > julianday('now')
         ORDER BY resource_key
        """,
        (task_id,),
    ).fetchall()
    dispatches = conn.execute(
        """
        SELECT id, attempt_id, state, last_error
          FROM task_launch_dispatch
         WHERE task_id = ?
         ORDER BY id
        """,
        (task_id,),
    ).fetchall()
    recent_defer_reasons = conn.execute(
        """
        SELECT payload
          FROM events
         WHERE task_id = ?
           AND event_type = 'task.executor.deferred'
         ORDER BY id DESC
         LIMIT 8
        """,
        (task_id,),
    ).fetchall()
    reasons = []
    for row in recent_defer_reasons:
        try:
            payload = json.loads(row["payload"] or "{}")
        except json.JSONDecodeError:
            payload = {}
        if payload.get("reason"):
            reasons.append(payload["reason"])

    print("[repro] local DB task:", json.dumps(dict(task), sort_keys=True))
    print("[repro] local DB active_ssh_lease_count:", len(active_leases))
    print("[repro] local DB dispatches:", json.dumps([dict(row) for row in dispatches], sort_keys=True))
    print("[repro] local DB recent_defer_reasons:", ",".join(sorted(set(reasons))))
finally:
    conn.close()
PY
else
  echo "[repro] local DB not found, skipped live diagnostic: $DB_PATH"
fi

INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test | tee "$log_file"

grep -Fq "self-test: pool-capacity deferred queued task blocks pending investigation" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] passed"

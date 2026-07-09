#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TASK_ID="wf-1778431097453-46/regression-inv-117"
DB_PATH="${INVOKER_DB_PATH:-${HOME:-.}/.invoker/invoker.db}"

state_dir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-active-dispatch-owner-repro.XXXXXX")"
state_file="$state_dir/submissions.tsv"
trap 'rm -rf "$state_dir"' EXIT

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: active launch-dispatch rows were present while no owner dispatcher was guaranteed alive"
echo "[repro] failure mode: retry loop escalated stale pending/launching queue work to Codex before giving the owner dispatcher a cycle to launch it"

python3 - "$ROOT" <<'PY'
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
script = (root / "scripts/retry-pending-autofix-failed.sh").read_text(encoding="utf-8")

task_id = "wf-1778431097453-46/regression-inv-117"
task = {
    "id": task_id,
    "status": "pending",
    "config": {
        "command": "pnpm run test:all",
        "executionAgent": "codex",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_3",
        "runnerKind": "ssh",
        "workflowId": "wf-1778431097453-46",
    },
    "execution": {
        "selectedAttemptId": f"{task_id}-a21776f85",
        "branch": "experiment/wf-1778431097453-46/regression-inv-117/g81.t180.a-a063969b2-6ccf4eee",
        "lastHeartbeatAt": "2026-06-06T01:43:09.976Z",
        "launchStartedAt": "2026-06-06T01:43:09.976Z",
        "phase": "launching",
    },
}
queue = {
    "maxConcurrency": 12,
    "queued": [],
    "running": [
        {
            "attemptId": f"{task_id}-a21776f85",
            "taskId": task_id,
        }
    ],
    "runningCount": 6,
}
active_dispatch_rows = [
    {
        "id": 5605,
        "taskId": task_id,
        "attemptId": f"{task_id}-a21776f85",
        "state": "enqueued",
        "attemptsCount": 2,
        "dispatchOwner": None,
        "fencedUntil": None,
    }
]
owner_ping_ready = False
audit = [
    (
        "2026-06-06 01:43:09",
        "task.launch_claimed",
        {
            "execution": {
                "selectedAttemptId": f"{task_id}-a21776f85",
                "generation": 182,
                "phase": "launching",
                "launchStartedAt": "2026-06-06T01:43:09.976Z",
            }
        },
    ),
    (
        "2026-06-06 01:43:09",
        "task.dispatch_enqueued",
        {
            "dispatchId": 5605,
            "attemptId": f"{task_id}-a21776f85",
            "workflowId": "wf-1778431097453-46",
            "generation": 182,
            "state": "enqueued",
        },
    ),
    (
        "2026-06-06 01:46:23",
        "task.launch_dispatch_reaped",
        {
            "dispatchId": 5605,
            "attemptId": f"{task_id}-a21776f85",
            "attemptsCount": 1,
            "reason": "lease_expired",
        },
    ),
    (
        "2026-06-06 01:49:23",
        "task.launch_dispatch_reaped",
        {
            "dispatchId": 5605,
            "attemptId": f"{task_id}-a21776f85",
            "attemptsCount": 2,
            "reason": "lease_expired",
        },
    ),
]

running_ids = {item["taskId"] for item in queue["running"]}
events = [event_type for _created_at, event_type, _payload in audit]
reaps = [payload for _created_at, event_type, payload in audit if event_type == "task.launch_dispatch_reaped"]
post_claim_executor_events = [
    event_type
    for _created_at, event_type, _payload in audit
    if event_type in {
        "task.executor.selected",
        "task.executor.deferred",
        "task.executor.startup-retry",
        "task.running",
        "task.failed",
    }
]

assert task["status"] == "pending"
assert task["execution"]["phase"] == "launching"
assert task_id in running_ids
assert active_dispatch_rows
assert any(row["state"] in {"enqueued", "leased"} for row in active_dispatch_rows)
assert events[:2] == ["task.launch_claimed", "task.dispatch_enqueued"]
assert len(reaps) == 2
assert {payload["reason"] for payload in reaps} == {"lease_expired"}
assert not post_claim_executor_events

old_retry_loop_would_investigate = (
    task["status"] == "pending"
    and task["execution"].get("phase") == "launching"
    and task_id in running_ids
    and bool(task["execution"].get("lastHeartbeatAt"))
)
fixed_loop_should_start_owner = bool(active_dispatch_rows) and not owner_ping_ready
fixed_retry_loop_starts_owner = (
    "active_launch_dispatch_count()" in script
    and "start_managed_headless_owner" in script
    and "managed_owner_started_for_dispatch=true" in script
    and "pending investigation deferred (managed owner dispatcher started for active launch dispatch rows:" in script
)
assert old_retry_loop_would_investigate
assert fixed_loop_should_start_owner
if not fixed_retry_loop_starts_owner:
    raise SystemExit("retry loop does not force owner dispatcher startup before pending investigation")

print("[repro] fixture asserts pending/launching task was queue-running with no executor launch event")
print("[repro] fixture asserts dispatch 5605 was repeatedly reaped for lease_expired")
print("[repro] fixture asserts active launch dispatch rows existed while owner ping was not ready")
print("[repro] source asserts fixed retry loop starts an owner and defers investigation for active dispatch rows")
PY

if [ -f "$DB_PATH" ]; then
  python3 - "$DB_PATH" "$TASK_ID" <<'PY'
import json
import pathlib
import sqlite3
import sys

db_path = pathlib.Path(sys.argv[1]).expanduser()
task_id = sys.argv[2]
try:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
except sqlite3.Error as exc:
    print(f"[repro] skipped live diagnostic: unable to open local DB: {exc}")
    raise SystemExit(0)
conn.row_factory = sqlite3.Row
try:
    task = conn.execute(
        """
        SELECT id, status, runner_kind, pool_id, pool_member_id, selected_attempt_id,
               launch_phase, launch_started_at, last_heartbeat_at
          FROM tasks
         WHERE id = ?
        """,
        (task_id,),
    ).fetchone()
    if task is None:
        print("[repro] local DB diagnostic: target task is no longer present")
        raise SystemExit(0)

    dispatch_rows = conn.execute(
        """
        SELECT id, attempt_id, state, attempts_count, dispatch_owner, fenced_until, last_error
          FROM task_launch_dispatch
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 5
        """,
        (task_id,),
    ).fetchall()
    recent_events = conn.execute(
        """
        SELECT event_type, payload
          FROM events
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 12
        """,
        (task_id,),
    ).fetchall()

    print("[repro] local DB task:", json.dumps(dict(task), sort_keys=True))
    print("[repro] local DB launch_dispatch_rows:", json.dumps([dict(row) for row in dispatch_rows], sort_keys=True))
    print("[repro] local DB recent_events:", json.dumps([dict(row) for row in recent_events], sort_keys=True))
except sqlite3.Error as exc:
    print(f"[repro] skipped live diagnostic: unable to read local DB: {exc}")
finally:
    conn.close()
PY
else
  echo "[repro] local DB not found, skipped live diagnostic: $DB_PATH"
fi

INVOKER_RETRY_PENDING_AUTOFIX_STATE_DIR="$state_dir" \
INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$state_file" \
  scripts/retry-pending-autofix-failed.sh --self-test

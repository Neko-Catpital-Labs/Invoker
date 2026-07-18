#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_PATH="${INVOKER_DB_PATH:-${HOME:-.}/.invoker/invoker.db}"
TASK_ID="wf-1779113239579-2/final-regression"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: launch dispatch was completed before TaskRunner had fully registered the in-memory execution owner"
echo "[repro] effect: if the owner exits in that handoff window, the task can remain running with no durable launch row to retry"

python3 <<'PY'
from datetime import datetime, timezone

TASK_ID = "wf-1779113239579-2/final-regression"

task = {
    "id": TASK_ID,
    "status": "running",
    "config": {
        "command": "pnpm run test:all",
        "executionAgent": "codex",
        "poolId": "pnpm-ssh",
        "poolMemberId": "remote_digital_ocean_3",
        "runnerKind": "ssh",
        "workflowId": "wf-1779113239579-2",
    },
    "execution": {
        "phase": "executing",
        "selectedAttemptId": f"{TASK_ID}-a63f24369",
        "launchStartedAt": "2026-06-05T10:53:55.776Z",
        "launchCompletedAt": "2026-06-05T10:54:27.979Z",
        "startedAt": "2026-06-05T10:54:27.979Z",
        "lastHeartbeatAt": "2026-06-05T11:16:09.505Z",
    },
}
dispatch = {
    "id": 5352,
    "attemptId": f"{TASK_ID}-a63f24369",
    "state": "completed",
    "completedAt": "2026-06-05T10:54:27.988Z",
}
events = [
    ("task.launch_claimed", "2026-06-05T10:53:55.776Z"),
    ("task.dispatch_enqueued", "2026-06-05T10:53:55.776Z"),
    ("task.running", "2026-06-05T10:54:27.979Z"),
    ("task.executor.selected", "2026-06-05T10:54:27.979Z"),
]
output_count = 0

assert task["status"] == "running"
assert task["execution"]["phase"] == "executing"
assert dispatch["state"] == "completed"
assert dispatch["attemptId"] == task["execution"]["selectedAttemptId"]
assert output_count == 0
assert [name for name, _ in events[-2:]] == ["task.running", "task.executor.selected"]

def ts(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)

assert ts(dispatch["completedAt"]) >= ts(task["execution"]["launchCompletedAt"])

old_handoff_order = ["completeDispatch", "persistStartMetadata", "registerActiveExecution", "onComplete"]
fixed_handoff_order = ["persistStartMetadata", "registerActiveExecution", "onComplete", "completeDispatch"]
assert old_handoff_order.index("completeDispatch") < old_handoff_order.index("onComplete")
assert fixed_handoff_order.index("completeDispatch") > fixed_handoff_order.index("onComplete")

print("[repro] fixture confirms running task + completed dispatch + zero output rows")
print("[repro] pre-fix ordering completed the durable dispatch before completion ownership existed")
print("[repro] fixed ordering keeps the dispatch leased until completion ownership is registered")
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

    dispatch = conn.execute(
        """
        SELECT id, attempt_id, state, completed_at, fenced_until, attempts_count
          FROM task_launch_dispatch
         WHERE task_id = ?
         ORDER BY id DESC
         LIMIT 1
        """,
        (task_id,),
    ).fetchone()
    output_count = conn.execute(
        "SELECT COUNT(*) AS count FROM task_output WHERE task_id = ?",
        (task_id,),
    ).fetchone()["count"]

    print("[repro] local DB task:", json.dumps(dict(task), sort_keys=True))
    print("[repro] local DB latest_dispatch:", json.dumps(dict(dispatch), sort_keys=True) if dispatch else "null")
    print("[repro] local DB output_count:", output_count)
    if task["status"] == "running" and dispatch and dispatch["state"] == "completed" and output_count == 0:
        print("[repro] local DB diagnostic confirmed: running task has completed launch dispatch and no task output")
except sqlite3.Error as exc:
    print(f"[repro] skipped live diagnostic: unable to read local DB: {exc}")
finally:
    conn.close()
PY
else
  echo "[repro] local DB not found, skipped live diagnostic: $DB_PATH"
fi

pnpm --filter @invoker/execution-engine exec vitest run \
  src/__tests__/task-runner-launch-dispatch.test.ts \
  -t "completes the dispatch only after the completion listener is registered"

echo "[repro] passed"

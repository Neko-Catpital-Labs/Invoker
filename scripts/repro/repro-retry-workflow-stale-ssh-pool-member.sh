#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
MODE="expect-bug"

case "${1:-}" in
  --expect-fixed)
    MODE="expect-fixed"
    shift
    ;;
  "" )
    ;;
  * )
    echo "usage: $0 [--expect-fixed]" >&2
    exit 2
    ;;
esac

if [ ! -f "$DB_PATH" ]; then
  echo "missing Invoker DB: $DB_PATH" >&2
  exit 2
fi

python3 - "$DB_PATH" "$MODE" <<'PY'
import json
import sqlite3
import sys

db_path, mode = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

rows = conn.execute(
    """
    SELECT
      id,
      workflow_id,
      status,
      runner_kind,
      pool_id,
      pool_member_id,
      workspace_path,
      branch,
      launch_phase,
      launch_started_at,
      started_at,
      last_heartbeat_at,
      selected_attempt_id
    FROM tasks
    WHERE status = 'pending'
      AND runner_kind = 'ssh'
      AND pool_id IS NOT NULL
      AND pool_member_id IS NOT NULL
      AND (workspace_path IS NOT NULL OR branch IS NOT NULL)
      AND launch_phase IS NULL
      AND launch_started_at IS NULL
    ORDER BY last_heartbeat_at DESC, id
    """
).fetchall()

def latest_events(task_id):
    events = conn.execute(
        """
        SELECT event_type, payload, created_at
        FROM events
        WHERE task_id = ?
          AND event_type IN (
            'task.executor.selected',
            'task.executor.deferred',
            'task.pending',
            'task.launch_dispatch_invalidated',
            'task.execution_resource_lease_released'
          )
        ORDER BY id DESC
        LIMIT 12
        """,
        (task_id,),
    ).fetchall()
    result = []
    for event in reversed(events):
        payload = event["payload"]
        try:
            payload = json.loads(payload) if payload else None
        except json.JSONDecodeError:
            pass
        result.append({
            "created_at": event["created_at"],
            "event_type": event["event_type"],
            "payload": payload,
        })
    return result

print(f"mode={mode}")
print(f"matching_stale_ssh_pins={len(rows)}")

for row in rows[:10]:
    data = dict(row)
    print(json.dumps(data, sort_keys=True))
    selected = any(event["event_type"] == "task.executor.selected" for event in latest_events(row["id"]))
    pending = any(event["event_type"] == "task.pending" for event in latest_events(row["id"]))
    deferred = any(event["event_type"] == "task.executor.deferred" for event in latest_events(row["id"]))
    print(
        "audit_flags "
        f"task={row['id']} "
        f"selected={str(selected).lower()} "
        f"pending_reset={str(pending).lower()} "
        f"deferred={str(deferred).lower()}"
    )
    for event in latest_events(row["id"])[-5:]:
        print(json.dumps(event, sort_keys=True))

if mode == "expect-fixed":
    if rows:
        print("FAIL: pending pool-routed SSH tasks still have stale explicit poolMemberId pins")
        sys.exit(1)
    print("PASS: no pending pool-routed SSH tasks retain stale explicit poolMemberId pins")
    sys.exit(0)

if not rows:
    print("FAIL: no stale SSH pool member pin found to demonstrate the retry deferral root cause")
    sys.exit(1)

print("PASS: stale explicit SSH poolMemberId pins are present on pending retry work")
PY

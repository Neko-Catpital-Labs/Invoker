#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
TASK_ID="${1:-wf-1778431095371-43/regression-inv-63}"

if [ ! -f "$DB_PATH" ]; then
  echo "FAIL: Invoker DB not found: $DB_PATH" >&2
  exit 1
fi

python3 - "$DB_PATH" "$TASK_ID" <<'PY'
import sqlite3
import sys

db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row

task = conn.execute(
    """
    SELECT id, status, selected_attempt_id, runner_kind, pool_member_id
    FROM tasks
    WHERE id = ?
    """,
    (task_id,),
).fetchone()
if task is None:
    print(f"FAIL: task not found: {task_id}", file=sys.stderr)
    sys.exit(1)

leases = conn.execute(
    """
    SELECT resource_key, holder_id, task_id, pool_id, pool_member_id,
           acquired_at, last_heartbeat_at, lease_expires_at
    FROM execution_resource_leases
    WHERE task_id = ?
      AND resource_type = 'ssh'
    ORDER BY pool_member_id, resource_key
    """,
    (task_id,),
).fetchall()

active_attempt = task["selected_attempt_id"]
duplicate_attempt_leases = [
    row for row in leases
    if active_attempt and active_attempt in (row["holder_id"] or "")
]
members = {row["pool_member_id"] for row in duplicate_attempt_leases}

print(f"task={task['id']}")
print(f"status={task['status']}")
print(f"selected_attempt_id={active_attempt}")
print(f"task_pool_member_id={task['pool_member_id']}")
print(f"ssh_leases_for_selected_attempt={len(duplicate_attempt_leases)}")
for row in duplicate_attempt_leases:
    print(
        "lease "
        f"member={row['pool_member_id']} "
        f"resource={row['resource_key']} "
        f"heartbeat={row['last_heartbeat_at']} "
        f"expires={row['lease_expires_at']}"
    )

if task["status"] != "running":
    print("FAIL: expected task to be running for this live capacity leak repro", file=sys.stderr)
    sys.exit(1)
if len(members) <= 1:
    print(
        "FAIL: duplicate SSH capacity leak is not present; expected the same selected attempt "
        "to hold leases on more than one SSH member",
        file=sys.stderr,
    )
    sys.exit(1)
if task["pool_member_id"] not in members:
    print(
        "FAIL: task row points at a member that is not among active selected-attempt leases",
        file=sys.stderr,
    )
    sys.exit(1)

stale_members = sorted(member for member in members if member != task["pool_member_id"])
print("PASS: duplicate selected-attempt SSH leases reproduce the capacity leak")
print("stale_duplicate_members=" + ",".join(stale_members))
PY

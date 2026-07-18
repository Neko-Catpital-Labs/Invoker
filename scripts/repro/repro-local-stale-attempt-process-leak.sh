#!/usr/bin/env bash
set -euo pipefail

DB_PATH="${INVOKER_DB_PATH:-$HOME/.invoker/invoker.db}"
TASK_ID="${1:-wf-1780385813241-5/capture-after-visual-proof}"

python3 - "$DB_PATH" "$TASK_ID" <<'PY'
import sqlite3
import subprocess
import sys

db_path, task_id = sys.argv[1], sys.argv[2]
conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
task = conn.execute(
    "SELECT id, status, selected_attempt_id FROM tasks WHERE id = ?",
    (task_id,),
).fetchone()
if task is None:
    print(f"FAIL: task not found: {task_id}", file=sys.stderr)
    sys.exit(1)

selected_attempt = task["selected_attempt_id"] or ""
slug = task_id.replace("/", "-")
matches = []
ps_output = subprocess.check_output(["ps", "-axo", "pid=,command="], text=True, errors="replace")
for line in ps_output.splitlines():
    stripped = line.strip()
    if not stripped:
        continue
    pid, _, cmd = stripped.partition(" ")
    if slug not in cmd and task_id not in cmd:
        continue
    matches.append((pid, cmd[:1000]))

print(f"task={task['id']}")
print(f"status={task['status']}")
print(f"selected_attempt_id={selected_attempt}")
print(f"matching_processes={len(matches)}")
for pid, cmd in matches[:80]:
    print(f"process pid={pid} selectedAttemptInCmd={selected_attempt in cmd} cmd={cmd}")

if task["status"] != "running":
    print("FAIL: expected task to be running for this live local process leak repro", file=sys.stderr)
    sys.exit(1)
if not matches:
    print("FAIL: no local processes found for running task", file=sys.stderr)
    sys.exit(1)
if selected_attempt and any(selected_attempt in cmd for _, cmd in matches):
    print("FAIL: live processes match selected attempt; stale-attempt leak is not present", file=sys.stderr)
    sys.exit(1)

print("PASS: running task has local processes from a stale/non-selected attempt")
PY

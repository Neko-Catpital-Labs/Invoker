#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

DB_PATH="${INVOKER_DB_PATH:-${HOME:-.}/.invoker/invoker.db}"
TASK_ID="wf-1780292402489-6/final-regression-test-all"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-final-regression-no-lease.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT
db="$tmpdir/repro.db"

echo "[repro] task: $TASK_ID"
echo "[repro] root cause: retry diagnostics misclassified SSH lease state around launch"
echo "[repro] effect: pending selected-attempt SSH leases could be misclassified, and running SSH tasks without active leases were not investigated"

sqlite3 "$db" <<'SQL'
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT,
  runner_kind TEXT,
  pool_member_id TEXT,
  selected_attempt_id TEXT
);

CREATE TABLE execution_resource_leases (
  resource_key TEXT,
  resource_type TEXT,
  holder_id TEXT,
  task_id TEXT,
  pool_id TEXT,
  pool_member_id TEXT,
  acquired_at TEXT,
  last_heartbeat_at TEXT,
  lease_expires_at TEXT,
  metadata_json TEXT,
  PRIMARY KEY(resource_key, holder_id)
);

INSERT INTO tasks VALUES
  ('wf-repro/final-regression', 'pending', 'ssh', 'remote_digital_ocean_4', 'wf-repro/final-regression-afea42916'),
  ('wf-repro/running-no-lease', 'running', 'ssh', 'remote_digital_ocean_4', 'wf-repro/running-no-lease-afea42916');

INSERT INTO execution_resource_leases
  (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
   acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
VALUES
  ('ssh:invoker@138.68.230.225:22', 'ssh',
   'runner:123:wf-repro/final-regression:wf-repro/final-regression-afea42916',
   'wf-repro/final-regression', 'pnpm-ssh', 'remote_digital_ocean_4',
   datetime('now'), datetime('now'), datetime('now', '+20 minutes'), NULL);
SQL

old_orphan_count="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM execution_resource_leases l
LEFT JOIN tasks t ON t.id = l.task_id
WHERE l.resource_type = 'ssh'
  AND l.task_id IS NOT NULL
  AND TRIM(l.task_id) != ''
  AND l.lease_expires_at IS NOT NULL
  AND julianday(l.lease_expires_at) > julianday('now')
  AND (
    COALESCE(t.status, '<missing>') != 'running'
    OR t.selected_attempt_id IS NULL
    OR TRIM(t.selected_attempt_id) = ''
    OR NOT (
      l.holder_id = t.selected_attempt_id
      OR l.holder_id LIKE '%:' || t.selected_attempt_id
    )
  );
SQL
)"

fixed_orphan_count="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM execution_resource_leases l
LEFT JOIN tasks t ON t.id = l.task_id
WHERE l.resource_type = 'ssh'
  AND l.task_id IS NOT NULL
  AND TRIM(l.task_id) != ''
  AND l.lease_expires_at IS NOT NULL
  AND julianday(l.lease_expires_at) > julianday('now')
  AND (
    t.id IS NULL
    OR COALESCE(t.status, '<missing>') NOT IN ('running', 'pending')
    OR t.selected_attempt_id IS NULL
    OR TRIM(t.selected_attempt_id) = ''
    OR NOT (
      l.holder_id = t.selected_attempt_id
      OR l.holder_id LIKE '%:' || t.selected_attempt_id
    )
  );
SQL
)"

running_without_lease_count="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM tasks t
WHERE t.status = 'running'
  AND t.runner_kind = 'ssh'
  AND t.selected_attempt_id IS NOT NULL
  AND TRIM(t.selected_attempt_id) != ''
  AND NOT EXISTS (
    SELECT 1
    FROM execution_resource_leases l
    WHERE l.resource_type = 'ssh'
      AND l.task_id = t.id
      AND l.lease_expires_at IS NOT NULL
      AND julianday(l.lease_expires_at) > julianday('now')
      AND (
        l.holder_id = t.selected_attempt_id
        OR l.holder_id LIKE '%:' || t.selected_attempt_id
      )
  );
SQL
)"

if [ "$old_orphan_count" != "1" ]; then
  echo "expected old cleanup query to misclassify the pending selected-attempt SSH lease, got $old_orphan_count" >&2
  exit 1
fi

if [ "$fixed_orphan_count" != "0" ]; then
  echo "expected fixed cleanup query to preserve the pending selected-attempt SSH lease, got $fixed_orphan_count" >&2
  exit 1
fi

if [ "$running_without_lease_count" != "1" ]; then
  echo "expected fixed detector to flag one running SSH task without a lease, got $running_without_lease_count" >&2
  exit 1
fi

python3 - "$ROOT" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
script = (root / "scripts/retry-pending-autofix-failed.sh").read_text(encoding="utf-8")

required = [
    "write_ssh_running_without_lease_file",
    "ssh-running-no-lease=",
    "pending investigation includes SSH running tasks without active leases",
    "COALESCE(t.status, '<missing>') NOT IN ('running', 'pending')",
]
missing = [needle for needle in required if needle not in script]
if missing:
    raise SystemExit("fixed retry diagnostics are missing: " + ", ".join(missing))

print("[repro] fixed source: pending selected-attempt SSH leases are preserved")
print("[repro] fixed source: running SSH tasks without active leases are routed to investigation")
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
               launch_phase, launch_started_at, launch_completed_at, started_at, last_heartbeat_at
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
           AND (
             holder_id = ?
             OR holder_id LIKE '%:' || ?
           )
         ORDER BY resource_key, holder_id
        """,
        (task_id, task["selected_attempt_id"], task["selected_attempt_id"]),
    ).fetchall()

    print("[repro] local DB task:", json.dumps(dict(task), sort_keys=True))
    print("[repro] local DB active_matching_ssh_lease_count:", len(active_leases))
    if task["status"] == "running" and task["runner_kind"] == "ssh":
        assert task["selected_attempt_id"]
        if len(active_leases) == 0:
            print("[repro] local DB diagnostic confirmed: running SSH task has no active matching lease")
        else:
            print("[repro] local DB diagnostic: target currently has an active matching lease")
except sqlite3.Error as exc:
    print(f"[repro] skipped live diagnostic: unable to read local DB: {exc}")
finally:
    conn.close()
PY
else
  echo "[repro] local DB not found, skipped live diagnostic: $DB_PATH"
fi

echo "[repro] passed"

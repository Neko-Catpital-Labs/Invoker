#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-ssh-no-lease.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

db="$tmpdir/repro.db"

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
  ('wf-repro/pending-ssh', 'pending', 'ssh', 'remote-a', 'wf-repro/pending-ssh-a1'),
  ('wf-repro/running-no-lease', 'running', 'ssh', 'remote-b', 'wf-repro/running-no-lease-a1');

INSERT INTO execution_resource_leases
  (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
   acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
VALUES
  ('ssh:invoker@host-a:22', 'ssh', 'owner:123:wf-repro/pending-ssh:wf-repro/pending-ssh-a1',
   'wf-repro/pending-ssh', 'pnpm-ssh', 'remote-a',
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
  echo "expected old query to misclassify the pending selected-attempt lease, got $old_orphan_count" >&2
  exit 1
fi

if [ "$fixed_orphan_count" != "0" ]; then
  echo "expected fixed orphan query to preserve the pending selected-attempt lease, got $fixed_orphan_count" >&2
  exit 1
fi

if [ "$running_without_lease_count" != "1" ]; then
  echo "expected fixed detector to flag the running SSH task without a lease, got $running_without_lease_count" >&2
  exit 1
fi

echo "repro passed: pending selected-attempt SSH leases are preserved and running SSH tasks without leases are detected"

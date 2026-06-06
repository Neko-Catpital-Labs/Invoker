#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-owner-idle-launch-dispatch.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

db="$tmpdir/repro.db"

sqlite3 "$db" <<'SQL'
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL
);

CREATE TABLE workflow_mutation_intents (
  id INTEGER PRIMARY KEY,
  status TEXT NOT NULL
);

CREATE TABLE task_launch_dispatch (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  state TEXT NOT NULL
);

INSERT INTO tasks (id, status)
VALUES ('wf-repro/launching-task', 'pending');

INSERT INTO task_launch_dispatch (id, task_id, state)
VALUES
  (1, 'wf-repro/launching-task', 'enqueued'),
  (2, 'wf-repro/launching-task', 'leased');
SQL

old_idle="$(sqlite3 "$db" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM workflow_mutation_intents
    WHERE status IN ('queued', 'running')
  ) THEN 'false'
  WHEN EXISTS (
    SELECT 1
    FROM tasks
    WHERE status IN ('running', 'fixing_with_ai')
  ) THEN 'false'
  ELSE 'true'
END;
SQL
)"

fixed_idle="$(sqlite3 "$db" <<'SQL'
SELECT CASE
  WHEN EXISTS (
    SELECT 1
    FROM workflow_mutation_intents
    WHERE status IN ('queued', 'running')
  ) THEN 'false'
  WHEN EXISTS (
    SELECT 1
    FROM task_launch_dispatch
    WHERE state IN ('enqueued', 'leased')
  ) THEN 'false'
  WHEN EXISTS (
    SELECT 1
    FROM tasks
    WHERE status IN ('running', 'fixing_with_ai')
  ) THEN 'false'
  ELSE 'true'
END;
SQL
)"

active_dispatches="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM task_launch_dispatch
WHERE state IN ('enqueued', 'leased');
SQL
)"

pending_launching_tasks="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM tasks
WHERE status = 'pending';
SQL
)"

if [ "$active_dispatches" != "2" ]; then
  echo "expected two active launch dispatch rows, got $active_dispatches" >&2
  exit 1
fi

if [ "$pending_launching_tasks" != "1" ]; then
  echo "expected one pending launching task, got $pending_launching_tasks" >&2
  exit 1
fi

if [ "$old_idle" != "true" ]; then
  echo "expected old idle predicate to wrongly report idle, got $old_idle" >&2
  exit 1
fi

if [ "$fixed_idle" != "false" ]; then
  echo "expected fixed idle predicate to stay non-idle, got $fixed_idle" >&2
  exit 1
fi

cat <<EOF
PASS: standalone owner idle must account for active launch dispatch rows.

pending_launching_tasks=$pending_launching_tasks
active_launch_dispatch_rows=$active_dispatches
old_idle_predicate=$old_idle
fixed_idle_predicate=$fixed_idle

Root cause reproduced: launch-outbox tasks can remain pending while their
task_launch_dispatch rows are enqueued or leased. An owner idle predicate that
only checks running/fixing tasks can exit and leave no dispatcher to consume them.
EOF

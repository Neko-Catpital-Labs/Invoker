#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-underfilled-capacity.XXXXXX)"
trap 'rm -rf "$TMP_DIR"' EXIT

DB="$TMP_DIR/invoker.db"
STATE_FILE="$TMP_DIR/retry-state.tsv"

sqlite3 "$DB" <<'SQL'
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL,
  status TEXT,
  runner_kind TEXT,
  pool_member_id TEXT,
  dependencies TEXT DEFAULT '[]',
  selected_attempt_id TEXT,
  launch_phase TEXT,
  blocked_by TEXT,
  started_at TEXT,
  last_heartbeat_at TEXT
);

CREATE TABLE task_launch_dispatch (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  state TEXT NOT NULL,
  enqueued_at TEXT,
  leased_at TEXT,
  completed_at TEXT,
  last_error TEXT
);

CREATE TABLE events (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload TEXT,
  created_at TEXT
);

CREATE TABLE execution_resource_leases (
  resource_key TEXT PRIMARY KEY,
  resource_type TEXT,
  holder_id TEXT,
  task_id TEXT,
  pool_member_id TEXT,
  last_heartbeat_at TEXT,
  lease_expires_at TEXT
);

INSERT INTO tasks
  (id, workflow_id, status, runner_kind, pool_member_id, dependencies, selected_attempt_id, launch_phase, started_at, last_heartbeat_at)
VALUES
  ('wf-a/ssh-regression', 'wf-a', 'running', 'ssh', 'remote-a', '[]', 'wf-a/ssh-regression-a1', 'executing', datetime('now', '-10 minutes'), datetime('now', '-20 seconds')),
  ('wf-b/ssh-regression', 'wf-b', 'running', 'ssh', 'remote-b', '[]', 'wf-b/ssh-regression-a1', 'executing', datetime('now', '-10 minutes'), datetime('now', '-20 seconds')),
  ('wf-c/visual-proof', 'wf-c', 'running', 'worktree', NULL, '[]', 'wf-c/visual-proof-a1', 'executing', datetime('now', '-10 minutes'), datetime('now', '-20 seconds')),
  ('wf-d/ready-worktree', 'wf-d', 'pending', 'worktree', NULL, '[]', 'wf-d/ready-worktree-a3', NULL, NULL, NULL),
  ('__merge__wf-d', 'wf-d', 'pending', 'merge', NULL, '["wf-d/ready-worktree"]', '__merge__wf-d-a1', NULL, NULL, NULL);

INSERT INTO execution_resource_leases
  (resource_key, resource_type, holder_id, task_id, pool_member_id, last_heartbeat_at, lease_expires_at)
VALUES
  ('ssh:remote-a', 'ssh', 'owner:wf-a/ssh-regression-a1', 'wf-a/ssh-regression', 'remote-a', datetime('now', '-20 seconds'), datetime('now', '+20 minutes')),
  ('ssh:remote-b', 'ssh', 'owner:wf-b/ssh-regression-a1', 'wf-b/ssh-regression', 'remote-b', datetime('now', '-20 seconds'), datetime('now', '+20 minutes'));

INSERT INTO task_launch_dispatch
  (id, task_id, attempt_id, workflow_id, state, enqueued_at, leased_at, completed_at, last_error)
VALUES
  (1, 'wf-d/ready-worktree', 'wf-d/ready-worktree-a1', 'wf-d', 'abandoned', datetime('now', '-8 minutes'), datetime('now', '-8 minutes'), datetime('now', '-7 minutes'), 'workflow cancellation'),
  (2, 'wf-d/ready-worktree', 'wf-d/ready-worktree-a2', 'wf-d', 'abandoned', datetime('now', '-6 minutes'), datetime('now', '-6 minutes'), datetime('now', '-5 minutes'), 'task deferred');

INSERT INTO events (id, task_id, event_type, payload, created_at)
VALUES
  (1, 'wf-d/ready-worktree', 'task.cancelled', '{"reason":"workflow retry superseded attempt"}', datetime('now', '-7 minutes')),
  (2, 'wf-d/ready-worktree', 'task.executor.deferred', '{"reason":"dependency-or-gate-not-runnable"}', datetime('now', '-5 minutes'));
SQL

printf 'retry-workflow\twf-d\t%s\n' "$(date +%s)" > "$STATE_FILE"

running_count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM tasks WHERE status='running';")"
active_dispatch_count="$(sqlite3 "$DB" "SELECT COUNT(*) FROM task_launch_dispatch WHERE state IN ('enqueued','leased','acknowledged');")"
ready_no_dispatch="$(
  sqlite3 -noheader "$DB" "
    WITH pending AS (
      SELECT id, COALESCE(dependencies, '[]') AS dependencies, COALESCE(selected_attempt_id, '') AS selected_attempt_id
      FROM tasks
      WHERE status = 'pending'
        AND COALESCE(runner_kind, 'worktree') != 'merge'
        AND COALESCE(blocked_by, '') = ''
    )
    SELECT p.id
    FROM pending p
    WHERE NOT EXISTS (
        SELECT 1
        FROM json_each(p.dependencies) dep
        LEFT JOIN tasks dt ON dt.id = dep.value
        WHERE COALESCE(dt.status, 'missing') NOT IN ('completed', 'complete', 'review_ready')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM task_launch_dispatch d
        WHERE d.task_id = p.id
          AND (p.selected_attempt_id = '' OR d.attempt_id = p.selected_attempt_id)
          AND d.state IN ('enqueued', 'leased', 'acknowledged')
      )
    ORDER BY p.id;
  "
)"
old_loop_would_skip="$(awk -F '\t' '$1 == "retry-workflow" && $2 == "wf-d" { found = 1 } END { print found ? "yes" : "no" }' "$STATE_FILE")"

echo "temporary_db=$DB"
echo "configured_capacity=12"
echo "running_count=$running_count"
echo "active_dispatch_count=$active_dispatch_count"
echo "ready_without_dispatch=$ready_no_dispatch"
echo "old_loop_would_skip_workflow_retry=$old_loop_would_skip"
echo "dispatch_timeline:"
sqlite3 -header -column "$DB" "
  SELECT id, task_id, attempt_id, state, completed_at, last_error
  FROM task_launch_dispatch
  ORDER BY id;
"

if [ "$running_count" != "3" ]; then
  echo "FAIL: expected exactly three running tasks" >&2
  exit 1
fi
if [ "$active_dispatch_count" != "0" ]; then
  echo "FAIL: expected no active dispatch rows" >&2
  exit 1
fi
if [ "$ready_no_dispatch" != "wf-d/ready-worktree" ]; then
  echo "FAIL: expected wf-d/ready-worktree to be ready without dispatch" >&2
  exit 1
fi
if [ "$old_loop_would_skip" != "yes" ]; then
  echo "FAIL: expected old loop retry memory to suppress workflow retry" >&2
  exit 1
fi

echo "fixed_loop_action=retry-task wf-d/ready-worktree"
echo "PASS: underfilled capacity is reproduced by a ready pending task with no active dispatch plus stale workflow retry memory"

#!/usr/bin/env bash
set -euo pipefail

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-capacity-underuse.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

db="$tmpdir/repro.db"

is_disk_full_error() {
  case "$1" in
    *"No space left on device"*|*"Out of diskspace"*|*"REMOTE_DISK_FULL"*)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

slugify_task_id() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/_/g'
}

sqlite3 "$db" <<'SQL'
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  runner_kind TEXT,
  pool_id TEXT,
  dependencies TEXT DEFAULT '[]',
  selected_attempt_id TEXT,
  error TEXT
);

CREATE TABLE task_launch_dispatch (
  id INTEGER PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  state TEXT NOT NULL
);

INSERT INTO tasks
  (id, status, runner_kind, pool_id, dependencies, selected_attempt_id, error)
VALUES
  (
    'wf-repro/ssh-upstream',
    'failed',
    'ssh',
    'pnpm-ssh',
    '[]',
    'wf-repro/ssh-upstream-a1',
    'Executor startup failed (ssh): fatal: cannot create directory: No space left on device'
  ),
  (
    'wf-repro/downstream-regression',
    'pending',
    'worktree',
    'pnpm-ssh',
    '["wf-repro/ssh-upstream"]',
    'wf-repro/downstream-regression-a1',
    NULL
  ),
  (
    'wf-repro/merge',
    'pending',
    'merge',
    NULL,
    '["wf-repro/downstream-regression"]',
    'wf-repro/merge-a1',
    NULL
  );
SQL

ready_count="$(sqlite3 "$db" <<'SQL'
WITH pending AS (
  SELECT
    id,
    COALESCE(dependencies, '[]') AS dependencies,
    COALESCE(selected_attempt_id, '') AS selected_attempt_id
  FROM tasks
  WHERE status = 'pending'
    AND COALESCE(runner_kind, 'worktree') != 'merge'
)
SELECT COUNT(*)
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
);
SQL
)"

failed_disk_blockers="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM tasks
WHERE status = 'failed'
  AND runner_kind = 'ssh'
  AND error LIKE '%No space left on device%';
SQL
)"

active_dispatches="$(sqlite3 "$db" <<'SQL'
SELECT COUNT(*)
FROM task_launch_dispatch
WHERE state IN ('enqueued', 'leased', 'acknowledged');
SQL
)"

configured_ssh_capacity=2

if [ "$ready_count" != "0" ]; then
  echo "expected zero runnable non-merge pending tasks, got $ready_count" >&2
  exit 1
fi

if [ "$failed_disk_blockers" != "1" ]; then
  echo "expected one disk-full SSH startup blocker, got $failed_disk_blockers" >&2
  exit 1
fi

if [ "$active_dispatches" != "0" ]; then
  echo "expected no active launch dispatch rows, got $active_dispatches" >&2
  exit 1
fi

cleanup_dir="$tmpdir/remote-cleanup"
mkdir -p "$cleanup_dir"

failed_total=0
disk_full_cleanup_skipped=0
analysis_failure_count=0
analysis_failures_file="$tmpdir/analysis-failures.txt"
: > "$analysis_failures_file"

while IFS=$'\t' read -r task_id runner_kind pool_id error_text; do
  [ -n "$task_id" ] || continue
  failed_total=$((failed_total + 1))

  if [ "$runner_kind" = "ssh" ] && is_disk_full_error "$error_text"; then
    disk_full_cleanup_skipped=$((disk_full_cleanup_skipped + 1))
    cleanup_marker="$cleanup_dir/$(slugify_task_id "$task_id").cleanup-skipped"
    {
      printf 'task_id=%s\n' "$task_id"
      printf 'runner_kind=%s\n' "$runner_kind"
      printf 'pool_id=%s\n' "$pool_id"
      printf 'cleanup=simulated-remote-execution-cleanup\n'
      printf 'reason=disk-full-ssh-infra-blocker\n'
      printf 'error=%s\n' "$error_text"
    } > "$cleanup_marker"
    continue
  fi

  analysis_failure_count=$((analysis_failure_count + 1))
  printf '%s\t%s\t%s\t%s\n' "$task_id" "$runner_kind" "$pool_id" "$error_text" >> "$analysis_failures_file"
done < <(
  sqlite3 -separator $'\t' "$db" <<'SQL'
SELECT
  id,
  COALESCE(runner_kind, ''),
  COALESCE(pool_id, ''),
  COALESCE(error, '')
FROM tasks
WHERE status = 'failed'
ORDER BY id;
SQL
)

if [ "$disk_full_cleanup_skipped" != "$failed_disk_blockers" ]; then
  echo "expected disk-full cleanup-skipped count to match disk-full blockers: cleanup-skipped=$disk_full_cleanup_skipped blockers=$failed_disk_blockers" >&2
  exit 1
fi

if [ "$analysis_failure_count" != "0" ]; then
  echo "unexpected non-disk-full failed tasks in repro failure analysis:" >&2
  sed -n '1,120p' "$analysis_failures_file" >&2
  exit 1
fi

cat <<EOF
PASS: spare runner capacity can be real while no runner is usable.

configured_ssh_capacity=$configured_ssh_capacity
ready_pending_non_merge_tasks=$ready_count
active_launch_dispatch_rows=$active_dispatches
failed_disk_full_ssh_blockers=$failed_disk_blockers
failed_tasks_total=$failed_total
disk_full_cleanup_skipped=$disk_full_cleanup_skipped
analysis_failure_count=$analysis_failure_count

Root cause reproduced: the queue is not filling all runners because the runnable frontier
is blocked by a failed SSH upstream task. More capacity cannot run downstream tasks until
the failed upstream task is retried/fixed.
EOF

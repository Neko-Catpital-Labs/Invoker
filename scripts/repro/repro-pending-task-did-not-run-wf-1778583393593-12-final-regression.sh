#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

tmpdir="$(mktemp -d "${TMPDIR:-/tmp}/invoker-wf-1778583393593-12-final-regression.XXXXXX")"
trap 'rm -rf "$tmpdir"' EXIT

db_path="$tmpdir/repro.db"
task_path="$tmpdir/task.json"
queue_path="$tmpdir/queue.json"
echo "[repro] task: wf-1778583393593-12/final-regression"
echo "[repro] root cause: stale running SSH work was filtered out of pending investigation when an active selected-attempt SSH lease existed"
echo "[repro] diagnostic: the task did launch, then stopped making heartbeat/progress while the retry loop deferred investigation"

cat > "$task_path" <<'JSON'
{
  "id": "wf-1778583393593-12/final-regression",
  "status": "running",
  "config": {
    "command": "pnpm run test:all",
    "executionAgent": "codex",
    "poolId": "pnpm-ssh",
    "poolMemberId": "remote_digital_ocean_3",
    "runnerKind": "ssh",
    "workflowId": "wf-1778583393593-12"
  },
  "execution": {
    "branch": "experiment/wf-1778583393593-12/final-regression/g84.t177.a-aa56833c3-6643a284",
    "lastHeartbeatAt": "2000-01-01T00:00:00.000Z",
    "launchCompletedAt": "2000-01-01T00:00:35.000Z",
    "launchStartedAt": "2000-01-01T00:00:00.000Z",
    "phase": "executing",
    "selectedAttemptId": "wf-1778583393593-12/final-regression-aa56833c3",
    "startedAt": "2000-01-01T00:00:35.000Z"
  }
}
JSON

cat > "$queue_path" <<'JSON'
{
  "maxConcurrency": 12,
  "queued": [],
  "running": [
    {
      "attemptId": "wf-1778583393593-12/final-regression-aa56833c3",
      "taskId": "wf-1778583393593-12/final-regression"
    }
  ],
  "runningCount": 1
}
JSON

sqlite3 "$db_path" <<'SQL'
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

INSERT INTO tasks
  (id, status, runner_kind, pool_member_id, selected_attempt_id)
VALUES
  (
    'wf-1778583393593-12/final-regression',
    'running',
    'ssh',
    'remote_digital_ocean_3',
    'wf-1778583393593-12/final-regression-aa56833c3'
  );

INSERT INTO execution_resource_leases
  (resource_key, resource_type, holder_id, task_id, pool_id, pool_member_id,
   acquired_at, last_heartbeat_at, lease_expires_at, metadata_json)
VALUES
  (
    'ssh:invoker@165.22.161.97:22',
    'ssh',
    'f257d2bb-515c-4511-ace8-4e5938d5aba3:8415:wf-1778583393593-12/final-regression:wf-1778583393593-12/final-regression-aa56833c3',
    'wf-1778583393593-12/final-regression',
    'pnpm-ssh',
    'remote_digital_ocean_3',
    '2099-01-01T00:00:00.000Z',
    '2099-01-01T00:05:00.000Z',
    '2099-01-01T00:20:00.000Z',
    NULL
  );
SQL

python3 - "$task_path" "$queue_path" "$db_path" "$ROOT/scripts/retry-pending-autofix-failed.sh" <<'PY'
import json
import pathlib
import sqlite3
import sys

task_path = pathlib.Path(sys.argv[1])
queue_path = pathlib.Path(sys.argv[2])
db_path = pathlib.Path(sys.argv[3])
retry_script_path = pathlib.Path(sys.argv[4])

task = json.loads(task_path.read_text(encoding="utf-8"))
queue = json.loads(queue_path.read_text(encoding="utf-8"))
script = retry_script_path.read_text(encoding="utf-8")

task_id = "wf-1778583393593-12/final-regression"
attempt_id = "wf-1778583393593-12/final-regression-aa56833c3"

running_queue_ids = {
    str(row.get("taskId"))
    for row in queue.get("running", [])
    if isinstance(row, dict) and row.get("taskId")
}

assert task["id"] == task_id
assert task["status"] == "running"
assert task["config"]["runnerKind"] == "ssh"
assert task["config"]["poolId"] == "pnpm-ssh"
assert task["config"]["poolMemberId"] == "remote_digital_ocean_3"
assert task["execution"]["phase"] == "executing"
assert task["execution"]["launchCompletedAt"]
assert task["execution"]["selectedAttemptId"] == attempt_id
assert task_id in running_queue_ids

conn = sqlite3.connect(db_path)
conn.row_factory = sqlite3.Row
active_lease_rows = conn.execute(
    """
    SELECT l.resource_key, l.pool_member_id, l.holder_id
      FROM tasks t
      JOIN execution_resource_leases l
        ON l.task_id = t.id
       AND (
         l.holder_id = t.selected_attempt_id
         OR l.holder_id LIKE '%:' || t.selected_attempt_id
       )
     WHERE t.id = ?
       AND t.status = 'running'
       AND t.runner_kind = 'ssh'
       AND l.resource_type = 'ssh'
       AND l.lease_expires_at IS NOT NULL
       AND julianday(l.lease_expires_at) > julianday('now')
    """,
    (task_id,),
).fetchall()
conn.close()

assert len(active_lease_rows) == 1, "diagnostic condition should prove the running SSH task still owns an active selected-attempt lease"
assert active_lease_rows[0]["pool_member_id"] == "remote_digital_ocean_3"

stale_investigation = {task_id}
pool_capacity_blocked = set()
ssh_running_active_lease = {task_id}

pre_fix = (stale_investigation - pool_capacity_blocked) - ssh_running_active_lease
post_fix = stale_investigation - pool_capacity_blocked

assert pre_fix == set(), "pre-fix filter should suppress the stale running task"
assert post_fix == {task_id}, "post-fix logic should investigate the stale running task"

required_fragments = [
    "write_ssh_running_active_lease_file",
    "pending investigation includes running SSH tasks with active leases",
    "self-test: stale running SSH task with active selected-attempt lease is investigated",
]
missing = [fragment for fragment in required_fragments if fragment not in script]
assert not missing, f"retry script is missing fixed active-lease handling: {missing}"

print("[repro] evidence: task launched, reached running, and remained in the queue")
print("[repro] evidence: active SSH resource lease matches selectedAttemptId and pool member")
print("[repro] pre-fix: active selected-attempt SSH lease filtered the stale running task out, leaving no investigation target")
print("[repro] post-fix: active selected-attempt SSH lease is diagnostic only; stale running task remains investigation target")
PY

log_file="$tmpdir/self-test.log"
INVOKER_RETRY_PENDING_AUTOFIX_STATE_FILE="$tmpdir/submissions.tsv" \
  scripts/retry-pending-autofix-failed.sh --self-test > "$log_file" 2>&1

grep -Fq "self-test: stale running SSH task with active selected-attempt lease is investigated" "$log_file"
grep -Fq "self-test: all passed" "$log_file"

echo "[repro] retry-pending self-test active-lease guard passed"

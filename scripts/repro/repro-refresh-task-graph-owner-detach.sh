#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_ROOT="$(mktemp -d -t invoker-refresh-detach.XXXXXX)"
WORKTREE_DIR="$TMP_ROOT/worktree"
HOME_DIR="$TMP_ROOT/home"
DB_DIR="$TMP_ROOT/db"
LOG_DIR="$TMP_ROOT/logs"
SOCKET_PATH="$TMP_ROOT/invoker.sock"
OWNER_LOG="$LOG_DIR/owner.log"
CONFIG_PATH="$HOME_DIR/.invoker/config.json"
PLAN_PATH="plans/fixtures/hello-world.yaml"
KEEP_TMP="${REPRO_KEEP_TMP:-0}"
OWNER_PID=""
WORKTREE_CREATED=0

cleanup() {
  if [[ -n "$OWNER_PID" ]] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  rm -f "$SOCKET_PATH"
  if [[ "$WORKTREE_CREATED" = "1" ]] && [[ -d "$WORKTREE_DIR" ]]; then
    git -C "$ROOT_DIR" worktree remove --force "$WORKTREE_DIR" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TMP" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  else
    echo "Kept temp repro dir: $TMP_ROOT" >&2
  fi
}
trap cleanup EXIT

mkdir -p "$HOME_DIR/.invoker" "$DB_DIR" "$LOG_DIR"

cat >"$CONFIG_PATH" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "maxConcurrency": 2,
  "autoFixRetries": 0
}
JSON

echo "==> creating isolated repro worktree"
git -C "$ROOT_DIR" worktree add --detach "$WORKTREE_DIR" HEAD >/dev/null
WORKTREE_CREATED=1

RUNNER="$WORKTREE_DIR/run.sh"
ELECTRON="$WORKTREE_DIR/scripts/electron.cjs"
MAIN="$WORKTREE_DIR/packages/app/dist/main.js"

wait_for_log() {
  local file="$1"
  local needle="$2"
  local deadline=$((SECONDS + 60))
  while (( SECONDS < deadline )); do
    if [[ -f "$file" ]] && python3 - "$file" "$needle" <<'PY'
import pathlib, sys
path = pathlib.Path(sys.argv[1])
needle = sys.argv[2]
raise SystemExit(0 if needle in path.read_text(errors='ignore') else 1)
PY
    then
      return 0
    fi
    sleep 0.25
  done
  echo "timed out waiting for '$needle' in $file" >&2
  if [[ -f "$file" ]]; then
    python3 - "$file" <<'PY' >&2
import pathlib, sys
path = pathlib.Path(sys.argv[1])
text = path.read_text(errors='ignore').splitlines()
for line in text[-120:]:
    print(line)
PY
  fi
  return 1
}

seed_dist() {
  echo "==> bootstrapping isolated workspace and app dist"
  pnpm --dir "$WORKTREE_DIR" install --frozen-lockfile >/dev/null
  pnpm --dir "$WORKTREE_DIR" --filter @invoker/transport build >/dev/null
  pnpm --dir "$WORKTREE_DIR" --filter @invoker/app build >/dev/null
  if [[ ! -f "$MAIN" ]] || [[ ! -f "$WORKTREE_DIR/packages/transport/dist/index.js" ]]; then
    echo "FAIL: isolated app or transport dist was not built" >&2
    exit 1
  fi
}

start_owner() {
  echo "==> starting isolated standalone owner"
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_IPC_SOCKET="$SOCKET_PATH" \
  INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
  INVOKER_HEADLESS_STANDALONE=1 \
  INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=900000 \
  NODE_ENV=test \
  "$ELECTRON" "$MAIN" --headless owner-serve >"$OWNER_LOG" 2>&1 &
  OWNER_PID="$!"
  wait_for_log "$OWNER_LOG" "standalone owner ready"
}
stop_owner() {
  local pids
  pids="$(python3 - "$WORKTREE_DIR" <<'PY'
import subprocess, sys
needle = sys.argv[1]
out = subprocess.check_output(['ps', '-axo', 'pid=,ppid=,args='], text=True)
for line in out.splitlines():
    if needle in line and '--headless owner-serve' in line:
        print(line.strip().split(None, 2)[0])
PY
)"
  if [[ -z "$pids" ]]; then
    return 0
  fi
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    kill "$pid" >/dev/null 2>&1 || true
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    if [[ -n "$children" ]]; then
      # shellcheck disable=SC2086
      kill $children >/dev/null 2>&1 || true
    fi
  done <<<"$pids"
  sleep 1
  while IFS= read -r pid; do
    [[ -n "$pid" ]] || continue
    if kill -0 "$pid" >/dev/null 2>&1; then
      kill -9 "$pid" >/dev/null 2>&1 || true
    fi
    children="$(pgrep -P "$pid" 2>/dev/null || true)"
    if [[ -n "$children" ]]; then
      # shellcheck disable=SC2086
      kill -9 $children >/dev/null 2>&1 || true
    fi
  done <<<"$pids"
}

bus_request() {
  local channel="$1"
  local payload_json="$2"
  HOME="$HOME_DIR" \
  INVOKER_DB_DIR="$DB_DIR" \
  INVOKER_IPC_SOCKET="$SOCKET_PATH" \
  node --input-type=module - "$WORKTREE_DIR" "$channel" "$payload_json" <<'NODE'
const [repoRoot, channel, payloadJson] = process.argv.slice(2);
const payload = JSON.parse(payloadJson);
const mod = await import(new URL(`file://${repoRoot}/packages/transport/dist/index.js`));
const bus = new mod.IpcBus(undefined, { allowServe: false, requestDeadlineMs: 1000 });
try {
  await bus.ready();
  const response = await bus.request(channel, payload);
  process.stdout.write(`${JSON.stringify({ ok: true, response })}\n`);
} catch (error) {
  process.stdout.write(`${JSON.stringify({
    ok: false,
    name: error?.name ?? null,
    code: error?.code ?? null,
    message: error instanceof Error ? error.message : String(error),
  })}\n`);
  process.exitCode = 1;
} finally {
  bus.disconnect();
}
NODE
}

query_db_counts() {
  python3 - "$DB_DIR/invoker.db" <<'PY'
import json, sqlite3, sys
conn = sqlite3.connect(sys.argv[1])
cur = conn.cursor()
workflow_count = cur.execute('select count(*) from workflows').fetchone()[0]
task_count = cur.execute('select count(*) from tasks').fetchone()[0]
completed = cur.execute("select count(*) from tasks where status='completed'").fetchone()[0]
print(json.dumps({
    'workflowCount': workflow_count,
    'taskCount': task_count,
    'completedTaskCount': completed,
}))
conn.close()
PY
}

seed_dist
start_owner

echo "==> proving owner answers before detach"
OWNER_PING_BEFORE="$(bus_request 'headless.owner-ping' '{}')"
echo "$OWNER_PING_BEFORE"
REFRESH_BEFORE="$(bus_request 'headless.query' '{"kind":"task-graph-refresh"}')"
echo "$REFRESH_BEFORE"

echo "==> creating isolated workflow state"
HOME="$HOME_DIR" \
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_IPC_SOCKET="$SOCKET_PATH" \
INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
NODE_ENV=test \
"$RUNNER" --headless run "$PLAN_PATH" --no-track >/dev/null

DB_COUNTS_BEFORE="$(query_db_counts)"
echo "$DB_COUNTS_BEFORE"
if [[ "$(python3 - "$DB_COUNTS_BEFORE" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
print('1' if payload['workflowCount'] >= 1 and payload['taskCount'] >= 1 else '0')
PY
)" != "1" ]]; then
  echo "FAIL: expected isolated DB to contain at least one workflow and task before detach" >&2
  exit 1
fi

echo "==> killing only the isolated standalone owner"
stop_owner
OWNER_PID=""
sleep 1

echo "==> proving refresh delegation now has no handler"
set +e
OWNER_PING_AFTER="$(bus_request 'headless.owner-ping' '{}' )"
OWNER_PING_STATUS=$?
REFRESH_AFTER="$(bus_request 'headless.query' '{"kind":"task-graph-refresh"}' )"
REFRESH_STATUS=$?
set -e

echo "$OWNER_PING_AFTER"
echo "$REFRESH_AFTER"

DB_COUNTS_AFTER="$(query_db_counts)"
echo "$DB_COUNTS_AFTER"

if [[ "$OWNER_PING_STATUS" -eq 0 ]]; then
  echo "FAIL: expected owner-ping to fail after killing the isolated owner" >&2
  exit 1
fi
if [[ "$REFRESH_STATUS" -eq 0 ]]; then
  echo "FAIL: expected headless.query task-graph-refresh to fail after killing the isolated owner" >&2
  exit 1
fi
if [[ "$(python3 - "$REFRESH_AFTER" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
print('1' if payload.get('code') == 'NO_HANDLER' else '0')
PY
)" != "1" ]]; then
  echo "FAIL: expected refresh failure to be NO_HANDLER" >&2
  exit 1
fi
if [[ "$(python3 - "$DB_COUNTS_AFTER" <<'PY'
import json, sys
payload = json.loads(sys.argv[1])
print('1' if payload['workflowCount'] >= 1 and payload['taskCount'] >= 1 else '0')
PY
)" != "1" ]]; then
  echo "FAIL: isolated DB lost workflow/task state after owner detach" >&2
  exit 1
fi

echo "PASS: refresh-task-graph depends on a live headless.query handler; after the standalone owner disappears the refresh path throws NO_HANDLER even though the local DB still has task/workflow state."
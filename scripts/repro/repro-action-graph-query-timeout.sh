#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$ROOT_DIR/scripts/headless-lib.sh"

EXPECTATION="fixed"
KEEP_TEMP=false
EVENT_COUNT=200000

usage() {
  echo "usage: $0 [--expect-bug|--expect-fixed] [--keep-temp] [--event-count <n>]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)
      EXPECTATION="bug"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    --keep-temp)
      KEEP_TEMP=true
      shift
      ;;
    --event-count)
      if [[ $# -lt 2 || ! "$2" =~ ^[0-9]+$ ]]; then
        usage
        exit 2
      fi
      EVENT_COUNT="$2"
      shift 2
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/iag.XXXXXX")"
HOME_DIR="$TMP_ROOT/home"
DB_DIR="$TMP_ROOT/db"
SOCKET_PATH="$TMP_ROOT/i.sock"
CONFIG_PATH="$TMP_ROOT/config.json"
PLAN_PATH="$TMP_ROOT/repro-plan.yaml"
REPO_FIXTURE_DIR="$TMP_ROOT/repo"
OWNER_LOG="$TMP_ROOT/owner.log"
SUBMIT_OUT="$TMP_ROOT/submit.out"
SUBMIT_ERR="$TMP_ROOT/submit.err"
TASKS_JSON="$TMP_ROOT/tasks.json"
QUERY_OUT="$TMP_ROOT/action-graph.out"
QUERY_ERR="$TMP_ROOT/action-graph.err"
QUERY_PLAN="$TMP_ROOT/query-plan.txt"
OWNER_PID=""

cleanup() {
  if [[ -n "$OWNER_PID" ]]; then
    local children
    children="$(pgrep -P "$OWNER_PID" 2>/dev/null || true)"
    if [[ -n "$children" ]]; then
      # shellcheck disable=SC2086
      kill $children 2>/dev/null || true
    fi
    kill "$OWNER_PID" 2>/dev/null || true
    wait "$OWNER_PID" 2>/dev/null || true
  fi
  if [[ "$KEEP_TEMP" == true ]]; then
    echo "temp root: $TMP_ROOT"
  else
    rm -rf "$TMP_ROOT" 2>/dev/null || true
  fi
}
trap cleanup EXIT

wait_for_log() {
  local file="$1"
  local needle="$2"
  local deadline=$((SECONDS + 45))
  while (( SECONDS < deadline )); do
    if [[ -f "$file" ]] && grep -Fq "$needle" "$file"; then
      return 0
    fi
    sleep 0.2
  done
  echo "timed out waiting for '$needle' in $file" >&2
  [[ -f "$file" ]] && tail -80 "$file" >&2
  return 1
}

require_node_sqlite() {
  if ! node -e "import('node:sqlite').catch(() => process.exit(1))" >/dev/null 2>&1; then
    echo "node:sqlite is required for this repro" >&2
    exit 1
  fi
}

build_if_missing() {
  pushd "$ROOT_DIR" >/dev/null
  if [[ ! -f packages/data-store/dist/index.js ]]; then
    pnpm --filter @invoker/data-store build
  fi
  if [[ ! -f packages/app/dist/main.js || ! -f packages/app/dist/headless-client.js ]]; then
    pnpm --filter @invoker/app build
  fi
  popd >/dev/null
}

start_owner() {
  INVOKER_DB_DIR="$DB_DIR" \
    INVOKER_IPC_SOCKET="$SOCKET_PATH" \
    INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
    INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=600000 \
    INVOKER_HEADLESS_STANDALONE=1 \
    HOME="$HOME_DIR" \
    "$ELECTRON" "$MAIN" $SANDBOX_FLAG --headless owner-serve >"$OWNER_LOG" 2>&1 &
  OWNER_PID="$!"
  wait_for_log "$OWNER_LOG" "standalone owner ready"
}

headless_client() {
  INVOKER_DB_DIR="$DB_DIR" \
    INVOKER_IPC_SOCKET="$SOCKET_PATH" \
    INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH" \
    HOME="$HOME_DIR" \
    node "$ROOT_DIR/packages/app/dist/headless-client.js" "$@"
}

wait_for_tasks_json() {
  local deadline=$((SECONDS + 30))
  while (( SECONDS < deadline )); do
    if headless_client query tasks --output json >"$TASKS_JSON" 2>/dev/null; then
      if node - "$TASKS_JSON" <<'NODE'
const fs = require('node:fs');
const tasks = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
process.exit(Array.isArray(tasks) && tasks.length >= 3 ? 0 : 1);
NODE
      then
        return 0
      fi
    fi
    sleep 0.2
  done
  echo "timed out waiting for submitted tasks" >&2
  [[ -f "$TASKS_JSON" ]] && cat "$TASKS_JSON" >&2
  return 1
}

seed_events_and_plan() {
  node - "$DB_DIR/invoker.db" "$TASKS_JSON" "$EVENT_COUNT" "$QUERY_PLAN" <<'NODE'
import fs from 'node:fs';
const [dbPath, tasksPath, countRaw, planPath] = process.argv.slice(2);
const count = Number(countRaw);
const tasks = JSON.parse(fs.readFileSync(tasksPath, 'utf8'));
const taskIds = tasks.map((task) => task.id).filter((id) => typeof id === 'string' && id.length > 0);
if (taskIds.length === 0) throw new Error('no task ids found');
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA foreign_keys = ON');
  const insert = db.prepare('INSERT INTO events (task_id, event_type, payload) VALUES (?, ?, ?)');
  db.exec('BEGIN');
  try {
    for (let seq = 0; seq < count; seq += 1) {
      insert.run(taskIds[seq % taskIds.length], 'repro.event', JSON.stringify({ seq }));
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  const planRows = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE task_id = ? ORDER BY id ASC').all(taskIds[0]);
  const details = planRows.map((row) => row.detail).join('\n');
  fs.writeFileSync(planPath, details, 'utf8');
} finally {
  db.close();
}
NODE
}

assert_fixed_action_graph() {
  node - "$QUERY_OUT" <<'NODE'
const fs = require('node:fs');
const raw = fs.readFileSync(process.argv[2], 'utf8');
const graph = JSON.parse(raw);
if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) {
  throw new Error('action graph JSON must include nodes and edges arrays');
}
let largestHistory = 0;
for (const node of graph.nodes) {
  if (node.kind === 'task-attempt' && Array.isArray(node.history)) {
    largestHistory = Math.max(largestHistory, node.history.length);
  }
}
if (largestHistory > 30) {
  throw new Error(`largest task-attempt history length ${largestHistory} exceeds 30`);
}
NODE
}

mkdir -p "$HOME_DIR" "$DB_DIR" "$REPO_FIXTURE_DIR"
require_node_sqlite
build_if_missing

cat > "$CONFIG_PATH" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true
}
JSON

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'action graph query timeout repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$PLAN_PATH" <<EOF
name: Action Graph Query Timeout Repro
repoUrl: $REPO_FIXTURE_DIR
onFinish: none
mergeMode: manual
baseBranch: HEAD
tasks:
  - id: repro-one
    description: First no-op task
    command: "true"
    dependencies: []
  - id: repro-two
    description: Second no-op task
    command: "true"
    dependencies: []
  - id: repro-three
    description: Third no-op task
    command: "true"
    dependencies: []
EOF

start_owner

if ! headless_client --no-track run "$PLAN_PATH" >"$SUBMIT_OUT" 2>"$SUBMIT_ERR"; then
  echo "failed to submit repro workflow" >&2
  cat "$SUBMIT_OUT" >&2 || true
  cat "$SUBMIT_ERR" >&2 || true
  exit 1
fi

wait_for_tasks_json
seed_events_and_plan
PLAN_DETAIL="$(cat "$QUERY_PLAN")"
printf 'query plan: %s\n' "$PLAN_DETAIL"

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$PLAN_DETAIL" == *"SCAN events"* ]]; then
    echo "PASS: event lookup scans events table"
    echo "PASS: action graph query timeout repro matched bug"
    exit 0
  fi
fi

set +e
headless_client query action-graph --output json >"$QUERY_OUT" 2>"$QUERY_ERR"
QUERY_STATUS=$?
set -e

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$QUERY_STATUS" -ne 0 ]] && grep -Fq "Live owner is present but did not serve action-graph query" "$QUERY_ERR"; then
    echo "PASS: action graph query timeout repro matched bug"
    exit 0
  fi
  echo "FAIL: expected action graph delegated query timeout" >&2
  cat "$QUERY_OUT" >&2 || true
  cat "$QUERY_ERR" >&2 || true
  exit 1
fi

if [[ "$PLAN_DETAIL" != *"SEARCH events"* || "$PLAN_DETAIL" != *"idx_events_task_id_id"* ]]; then
  echo "FAIL: expected indexed SEARCH events plan using idx_events_task_id_id" >&2
  cat "$QUERY_PLAN" >&2
  exit 1
fi
if [[ "$PLAN_DETAIL" == *"SCAN events"* || "$PLAN_DETAIL" == *"USE TEMP B-TREE"* ]]; then
  echo "FAIL: expected no scan or temp sort in event lookup plan" >&2
  cat "$QUERY_PLAN" >&2
  exit 1
fi
if [[ "$QUERY_STATUS" -ne 0 ]]; then
  echo "FAIL: action graph query failed" >&2
  cat "$QUERY_OUT" >&2 || true
  cat "$QUERY_ERR" >&2 || true
  exit 1
fi
assert_fixed_action_graph

echo "PASS: action graph query timeout repro matched fixed"

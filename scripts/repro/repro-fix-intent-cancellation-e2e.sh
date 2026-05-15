#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
KEEP_TEMP=false
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"
AGENT_SLEEP_SECONDS="${REPRO_AGENT_SLEEP_SECONDS:-15}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-fix-intent-cancellation-e2e.sh [--expect bug|fixed] [--keep-temp]

What it proves:
  This is a product-path repro, not a unit-test wrapper.

  1. Starts a real GUI owner against an isolated SQLite DB.
  2. Submits a real workflow with a task that fails in a managed worktree.
  3. Starts a real headless `fix <task>` command delegated to the GUI owner.
  4. The fix runs a slow fake Claude command that sleeps, edits the worktree,
     then exits 0.
  5. While the fix is still in flight, starts a real headless
     `recreate-task <task>` command.
  6. Asserts that the stale fix result does not put the recreated task back
     into awaiting_approval after the recreate-task intent starts.

Bug expectation:
  The stale fix finalization wins after recreate-task and writes a fresh
  awaiting_approval event after the recreate intent.

Fixed expectation:
  The fix intent is superseded or failed, and no awaiting_approval event is
  written after the recreate-task intent begins.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-temp)
      KEEP_TEMP=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "bug" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires bug|fixed" >&2
  usage >&2
  exit 2
fi

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "repro: missing required command: $1" >&2
    exit 2
  }
}

require_cmd node
require_cmd pnpm
require_cmd sqlite3

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-fix-intent-e2e.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
CONFIG_PATH="$DB_DIR/config.json"
IPC_SOCKET_PATH="$TMP_DIR/i.sock"
STUB_DIR="$TMP_DIR/stub"
CLAUDE_STUB="$STUB_DIR/claude"
AGENT_STARTED="$TMP_DIR/agent-started.marker"
AGENT_DONE="$TMP_DIR/agent-done.marker"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
SUBMIT_STDOUT="$TMP_DIR/submit.stdout.log"
SUBMIT_STDERR="$TMP_DIR/submit.stderr.log"
FIX_STDOUT="$TMP_DIR/fix.stdout.log"
FIX_STDERR="$TMP_DIR/fix.stderr.log"
RECREATE_STDOUT="$TMP_DIR/recreate.stdout.log"
RECREATE_STDERR="$TMP_DIR/recreate.stderr.log"

cleanup() {
  if [[ -n "${FIX_PID:-}" ]]; then
    kill "$FIX_PID" >/dev/null 2>&1 || true
    wait "$FIX_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${RECREATE_PID:-}" ]]; then
    kill "$RECREATE_PID" >/dev/null 2>&1 || true
    wait "$RECREATE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${OWNER_PID:-}" ]]; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TEMP" != true ]]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

query_sqlite_value() {
  local sql="$1"
  sqlite3 -noheader "$DB_DIR/invoker.db" "$sql"
}

sqlite_schema_ready() {
  [[ -f "$DB_DIR/invoker.db" ]] || return 1
  local exists
  exists="$(sqlite3 -noheader "$DB_DIR/invoker.db" "select count(*) from sqlite_master where type='table' and name='tasks';" 2>/dev/null || true)"
  [[ "$exists" == "1" ]]
}

wait_for_query_status() {
  local task_id="$1"
  local expected_status="$2"
  local timeout="$3"
  local started_at
  started_at="$(date +%s)"
  while true; do
    if sqlite_schema_ready; then
      local status
      status="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$task_id' limit 1;")"
      if [[ "$status" == "$expected_status" ]]; then
        return 0
      fi
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for $task_id to reach $expected_status" >&2
      return 1
    fi
    sleep 0.2
  done
}

wait_for_file() {
  local file="$1"
  local timeout="$2"
  local started_at
  started_at="$(date +%s)"
  while [[ ! -f "$file" ]]; do
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for file $file" >&2
      return 1
    fi
    sleep 0.1
  done
}

wait_for_owner_ready() {
  local timeout="$1"
  local started_at
  started_at="$(date +%s)"
  while true; do
    if [[ -S "$IPC_SOCKET_PATH" ]] || grep -q 'owner-ipc-ready' "$DB_DIR/invoker.log" 2>/dev/null; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for GUI owner IPC readiness" >&2
      return 1
    fi
    sleep 0.1
  done
}

cd "$ROOT_DIR"

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"

mkdir -p "$DB_DIR" "$REPO_FIXTURE_DIR" "$STUB_DIR"

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'fix intent cancellation repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 1,
  "autoFixRetries": 0
}
EOF

cat > "$CLAUDE_STUB" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf 'started\n' > "$AGENT_STARTED"
printf 'slow fake claude started\n'
sleep "$AGENT_SLEEP_SECONDS"
printf 'late fix write\n' >> fix-intent-late-write.txt
git add fix-intent-late-write.txt >/dev/null 2>&1 || true
printf 'done\n' > "$AGENT_DONE"
printf 'slow fake claude done\n'
EOF
chmod +x "$CLAUDE_STUB"

cat > "$PLAN_PATH" <<EOF
name: Fix Intent Cancellation E2E Repro
repoUrl: $REPO_FIXTURE_DIR
tasks:
  - id: target
    description: Fails once so a real fix command can run in the managed worktree
    command: >-
      bash -lc 'echo ORIGINAL_FAIL; exit 1'
EOF

HOME="$HOME_DIR" \
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_CLAUDE_FIX_COMMAND="$CLAUDE_STUB" \
NODE_ENV=test \
  "$ELECTRON_BIN" "$MAIN_JS" >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

wait_for_owner_ready 20

set +e
HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_CLAUDE_FIX_COMMAND="$CLAUDE_STUB" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" --no-track run "$PLAN_PATH" >"$SUBMIT_STDOUT" 2>"$SUBMIT_STDERR"
SUBMIT_STATUS=$?
set -e

WORKFLOW_ID="$(
  {
    sed -n 's/^Workflow ID: //p' "$SUBMIT_STDOUT"
    sed -n 's/^Delegated to owner .*workflow: //p' "$SUBMIT_STDOUT"
    sed -n 's/^Delegated to GUI .*workflow: //p' "$SUBMIT_STDOUT"
  } | head -n1
)"

if [[ "$SUBMIT_STATUS" -ne 0 || -z "${WORKFLOW_ID:-}" ]]; then
  echo "repro: failed to submit workflow" >&2
  cat "$SUBMIT_STDOUT" >&2 || true
  cat "$SUBMIT_STDERR" >&2 || true
  exit 1
fi

TASK_ID="$WORKFLOW_ID/target"
wait_for_query_status "$TASK_ID" "failed" "$TIMEOUT_SECONDS"

echo "repro: seeded failed task"
echo "workflow: $WORKFLOW_ID"
echo "task: $TASK_ID"

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_CLAUDE_FIX_COMMAND="$CLAUDE_STUB" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" fix "$TASK_ID" >"$FIX_STDOUT" 2>"$FIX_STDERR" &
FIX_PID=$!

wait_for_file "$AGENT_STARTED" 30

FIX_INTENT_ID=""
for _ in {1..100}; do
  FIX_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and (channel = 'invoker:fix-with-agent' or args_json like '%\"fix\",\"$TASK_ID\"%');")"
  if [[ -n "$FIX_INTENT_ID" && "$FIX_INTENT_ID" != "0" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$FIX_INTENT_ID" || "$FIX_INTENT_ID" == "0" ]]; then
  echo "repro: failed to capture fix intent" >&2
  exit 1
fi

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" \
INVOKER_CLAUDE_FIX_COMMAND="$CLAUDE_STUB" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" recreate-task "$TASK_ID" >"$RECREATE_STDOUT" 2>"$RECREATE_STDERR" &
RECREATE_PID=$!

RECREATE_INTENT_ID=""
for _ in {1..100}; do
  RECREATE_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate-task\",\"$TASK_ID\"%';")"
  if [[ -n "$RECREATE_INTENT_ID" && "$RECREATE_INTENT_ID" != "0" && "$RECREATE_INTENT_ID" != "$FIX_INTENT_ID" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$RECREATE_INTENT_ID" || "$RECREATE_INTENT_ID" == "0" ]]; then
  echo "repro: failed to capture recreate-task intent" >&2
  cat "$RECREATE_STDERR" >&2 || true
  exit 1
fi

wait_for_file "$AGENT_DONE" "$TIMEOUT_SECONDS"
wait "$FIX_PID" >/dev/null 2>&1 || true
FIX_PID=""
wait "$RECREATE_PID" >/dev/null 2>&1 || true
RECREATE_PID=""
sleep 1

FIX_STATUS="$(query_sqlite_value "select coalesce(status,'') from workflow_mutation_intents where id = $FIX_INTENT_ID;")"
RECREATE_STATUS="$(query_sqlite_value "select coalesce(status,'') from workflow_mutation_intents where id = $RECREATE_INTENT_ID;")"
TASK_STATUS="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$TASK_ID';")"
AWAITING_AFTER_RECREATE="$(
  query_sqlite_value "select count(*) from events where task_id = '$TASK_ID' and event_type = 'task.awaiting_approval' and created_at >= (select created_at from workflow_mutation_intents where id = $RECREATE_INTENT_ID);"
)"
FIXING_AFTER_RECREATE="$(
  query_sqlite_value "select count(*) from events where task_id = '$TASK_ID' and event_type = 'task.fixing_with_ai' and created_at >= (select created_at from workflow_mutation_intents where id = $RECREATE_INTENT_ID);"
)"

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$AWAITING_AFTER_RECREATE" == "0" ]]; then
    echo "repro: expected stale fix to write awaiting_approval after recreate-task, but it did not" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
else
  if [[ "$AWAITING_AFTER_RECREATE" != "0" ]]; then
    echo "repro: stale fix wrote awaiting_approval after recreate-task" >&2
    exit 1
  fi
  if [[ "$FIX_STATUS" != "failed" && "$FIX_STATUS" != "completed" ]]; then
    echo "repro: expected fix intent to be terminal after preemption, got $FIX_STATUS" >&2
    exit 1
  fi
  echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "task: $TASK_ID status=$TASK_STATUS"
echo "fix intent: $FIX_INTENT_ID status=$FIX_STATUS"
echo "recreate-task intent: $RECREATE_INTENT_ID status=$RECREATE_STATUS"
echo "awaiting_approval events after recreate-task: $AWAITING_AFTER_RECREATE"
echo "fixing_with_ai events after recreate-task: $FIXING_AFTER_RECREATE"
echo "tmp-dir: $TMP_DIR"

#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-90}"
KEEP_TEMP=false
EXPECTATION="fixed"

for arg in "$@"; do
  case "$arg" in
    --keep-temp) KEEP_TEMP=true ;;
    --expect-bug) EXPECTATION="bug" ;;
    --expect-fixed) EXPECTATION="fixed" ;;
    *)
      echo "usage: $0 [--keep-temp] [--expect-bug|--expect-fixed]" >&2
      exit 2
      ;;
  esac
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-recreate-queue.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
CONFIG_PATH="$DB_DIR/config.json"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
IPC_SOCKET_PATH="$DB_DIR/repro-ipc.sock"
GUI_STDOUT="$TMP_DIR/gui.stdout.log"
GUI_STDERR="$TMP_DIR/gui.stderr.log"
SUBMIT_STDOUT="$TMP_DIR/submit.stdout.log"
SUBMIT_STDERR="$TMP_DIR/submit.stderr.log"
RECREATE1_STDOUT="$TMP_DIR/recreate1.stdout.log"
RECREATE1_STDERR="$TMP_DIR/recreate1.stderr.log"
RECREATE2_STDOUT="$TMP_DIR/recreate2.stdout.log"
RECREATE2_STDERR="$TMP_DIR/recreate2.stderr.log"

cleanup() {
  if [[ -n "${RECREATE1_PID:-}" ]]; then
    kill "$RECREATE1_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${RECREATE2_PID:-}" ]]; then
    kill "$RECREATE2_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${GUI_WRAPPER_PID:-}" ]]; then
    kill "$GUI_WRAPPER_PID" >/dev/null 2>&1 || true
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
    if ! sqlite_schema_ready; then
      if (( $(date +%s) - started_at >= timeout )); then
        echo "repro: timed out waiting for sqlite schema before polling $task_id" >&2
        return 1
      fi
      sleep 0.2
      continue
    fi
    local status
    status="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$task_id' limit 1;")"
    if [[ "$status" == "$expected_status" ]]; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for $task_id to reach status $expected_status (last=$status)" >&2
      return 1
    fi
    sleep 0.2
  done
}

wait_for_intent_status() {
  local intent_id="$1"
  local expected_status="$2"
  local timeout="$3"
  local started_at
  started_at="$(date +%s)"
  while true; do
    local status
    status="$(query_sqlite_value "select coalesce(status,'') from workflow_mutation_intents where id = $intent_id limit 1;")"
    if [[ "$status" == "$expected_status" ]]; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for intent $intent_id to reach status $expected_status (last=$status)" >&2
      return 1
    fi
    sleep 0.2
  done
}

mkdir -p "$DB_DIR" "$REPO_FIXTURE_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'recreate queue repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 2
}
EOF

cat > "$PLAN_PATH" <<EOF
name: Recreate Blocked By Running Workflow Mutation Repro
repoUrl: $REPO_FIXTURE_DIR
tasks:
  - id: completed-fast
    description: Fast task that reaches completed before recreate
    command: >-
      bash -lc 'exit 0'
  - id: hold-open
    description: Slow task that keeps recreate running long enough for a second recreate to queue behind it
    command: >-
      bash -lc 'sleep 20'
EOF

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" >"$GUI_STDOUT" 2>"$GUI_STDERR" &
GUI_WRAPPER_PID=$!

for _ in {1..200}; do
  if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    GUI_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    if [[ -n "$GUI_PID" ]] && kill -0 "$GUI_PID" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 0.1
done

if [[ -z "${GUI_PID:-}" ]] || ! kill -0 "$GUI_PID" >/dev/null 2>&1; then
  echo "repro: GUI owner failed to start" >&2
  cat "$GUI_STDERR" >&2 || true
  exit 1
fi

set +e
HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
  >"$SUBMIT_STDOUT" 2>"$SUBMIT_STDERR"
SUBMIT_STATUS=$?
set -e

WORKFLOW_ID="$(
  {
    sed -n 's/^Workflow ID: //p' "$SUBMIT_STDOUT"
    sed -n 's/^Delegated to GUI .*workflow: //p' "$SUBMIT_STDOUT"
  } | head -n1
)"

if [[ -z "${WORKFLOW_ID:-}" ]]; then
  for _ in {1..100}; do
    WORKFLOW_ID="$(HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless query workflows --output label 2>/dev/null | tail -n1)"
    [[ -n "${WORKFLOW_ID:-}" ]] && break
    sleep 0.1
  done
fi

if [[ "$SUBMIT_STATUS" -ne 0 || -z "${WORKFLOW_ID:-}" ]]; then
  echo "repro: failed to submit workflow" >&2
  cat "$SUBMIT_STDOUT" >&2 || true
  cat "$SUBMIT_STDERR" >&2 || true
  exit 1
fi

FAST_ID="$WORKFLOW_ID/completed-fast"
SLOW_ID="$WORKFLOW_ID/hold-open"

wait_for_query_status "$FAST_ID" "completed" "$TIMEOUT_SECONDS"
wait_for_query_status "$SLOW_ID" "running" "$TIMEOUT_SECONDS"

echo "repro: seeded workflow"
echo "workflow: $WORKFLOW_ID"
echo "completed task: $FAST_ID"
echo "running task: $SLOW_ID"

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_ID" \
  >"$RECREATE1_STDOUT" 2>"$RECREATE1_STDERR" &
RECREATE1_PID=$!

RECREATE1_INTENT_ID=""
for _ in {1..100}; do
  RECREATE1_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate\",\"$WORKFLOW_ID\"%';")"
  if [[ -n "$RECREATE1_INTENT_ID" && "$RECREATE1_INTENT_ID" != "0" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$RECREATE1_INTENT_ID" ]]; then
  echo "repro: failed to capture first recreate intent id" >&2
  cat "$RECREATE1_STDERR" >&2 || true
  exit 1
fi

wait_for_intent_status "$RECREATE1_INTENT_ID" "running" 15

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_ID" \
  >"$RECREATE2_STDOUT" 2>"$RECREATE2_STDERR" &
RECREATE2_PID=$!

RECREATE2_INTENT_ID=""
for _ in {1..100}; do
  RECREATE2_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate\",\"$WORKFLOW_ID\"%';")"
  if [[ -n "$RECREATE2_INTENT_ID" && "$RECREATE2_INTENT_ID" != "$RECREATE1_INTENT_ID" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$RECREATE2_INTENT_ID" || "$RECREATE2_INTENT_ID" == "$RECREATE1_INTENT_ID" ]]; then
  echo "repro: failed to capture second recreate intent id" >&2
  cat "$RECREATE2_STDERR" >&2 || true
  exit 1
fi

sleep 3

RECREATE1_STATUS="$(query_sqlite_value "select status from workflow_mutation_intents where id = $RECREATE1_INTENT_ID;")"
RECREATE2_STATUS="$(query_sqlite_value "select status from workflow_mutation_intents where id = $RECREATE2_INTENT_ID;")"
RECREATE2_PENDING_EVENTS="$(query_sqlite_value "select count(*) from events where task_id like '$WORKFLOW_ID/%' and event_type = 'task.pending' and created_at >= (select created_at from workflow_mutation_intents where id = $RECREATE2_INTENT_ID);")"
FAST_STATUS_AFTER_SECOND="$(query_sqlite_value "select status from tasks where id = '$FAST_ID';")"
SLOW_STATUS_AFTER_SECOND="$(query_sqlite_value "select status from tasks where id = '$SLOW_ID';")"

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$RECREATE1_STATUS" != "running" ]]; then
    echo "repro: expected first recreate intent to still be running, got $RECREATE1_STATUS" >&2
    exit 1
  fi
  if [[ "$RECREATE2_STATUS" != "queued" ]]; then
    echo "repro: expected second recreate intent to be queued behind the running workflow mutation, got $RECREATE2_STATUS" >&2
    exit 1
  fi
  if [[ "$RECREATE2_PENDING_EVENTS" != "0" ]]; then
    echo "repro: expected no fresh task.pending events after second recreate was queued, saw $RECREATE2_PENDING_EVENTS" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
else
  if [[ "$RECREATE1_STATUS" != "failed" ]]; then
    echo "repro: expected first recreate intent to be superseded and failed, got $RECREATE1_STATUS" >&2
    exit 1
  fi
  if [[ "$RECREATE2_STATUS" != "running" && "$RECREATE2_STATUS" != "completed" ]]; then
    echo "repro: expected second recreate intent to take authority immediately, got $RECREATE2_STATUS" >&2
    exit 1
  fi
  if [[ "$RECREATE2_PENDING_EVENTS" == "0" ]]; then
    echo "repro: expected fresh task.pending events after second recreate took over, saw 0" >&2
    exit 1
  fi
  echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "first recreate intent: $RECREATE1_INTENT_ID status=$RECREATE1_STATUS"
echo "second recreate intent: $RECREATE2_INTENT_ID status=$RECREATE2_STATUS"
echo "task.pending events after second recreate enqueue: $RECREATE2_PENDING_EVENTS"
echo "task status after second recreate enqueue: $FAST_ID=$FAST_STATUS_AFTER_SECOND"
echo "task status after second recreate enqueue: $SLOW_ID=$SLOW_STATUS_AFTER_SECOND"
echo "tmp-dir: $TMP_DIR"

popd >/dev/null

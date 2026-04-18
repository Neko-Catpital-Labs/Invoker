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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-recreate-task-queue.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
CONFIG_PATH="$DB_DIR/config.json"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
IPC_SOCKET_PATH="$TMP_DIR/i.sock"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
SUBMIT_STDOUT="$TMP_DIR/submit.stdout.log"
SUBMIT_STDERR="$TMP_DIR/submit.stderr.log"
BLOCKER_RECREATE_STDOUT="$TMP_DIR/blocker-recreate.stdout.log"
BLOCKER_RECREATE_STDERR="$TMP_DIR/blocker-recreate.stderr.log"
TARGET_RECREATE_STDOUT="$TMP_DIR/target-recreate.stdout.log"
TARGET_RECREATE_STDERR="$TMP_DIR/target-recreate.stderr.log"

cleanup() {
  if [[ -n "${BLOCKER_RECREATE_PID:-}" ]]; then
    kill "$BLOCKER_RECREATE_PID" >/dev/null 2>&1 || true
    wait "$BLOCKER_RECREATE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TARGET_RECREATE_PID:-}" ]]; then
    kill "$TARGET_RECREATE_PID" >/dev/null 2>&1 || true
    wait "$TARGET_RECREATE_PID" >/dev/null 2>&1 || true
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

mkdir -p "$DB_DIR" "$REPO_FIXTURE_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'recreate task queue repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 2
}
EOF

cat > "$PLAN_PATH" <<EOF
name: Recreate Task Blocked By Running Workflow Mutation Repro
repoUrl: $REPO_FIXTURE_DIR
tasks:
  - id: target-fast
    description: Completed task that should reset immediately when recreate-task takes authority
    command: >-
      bash -lc 'exit 0'
  - id: blocker-slow
    description: Running task whose recreate-task mutation keeps the workflow mutation queue occupied
    command: >-
      bash -lc 'sleep 20'
EOF

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test \
  "$ELECTRON_BIN" "$MAIN_JS" >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

for _ in {1..200}; do
  if kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done

if ! kill -0 "$OWNER_PID" >/dev/null 2>&1; then
  echo "repro: GUI owner failed to start" >&2
  cat "$OWNER_STDERR" >&2 || true
  exit 1
fi

wait_for_owner_ready 20

set +e
HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test node "$HEADLESS_CLIENT_JS" --no-track run "$PLAN_PATH" \
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
    WORKFLOW_ID="$(HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test node "$HEADLESS_CLIENT_JS" query workflows --output label 2>/dev/null | tail -n1)"
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

TARGET_ID="$WORKFLOW_ID/target-fast"
BLOCKER_ID="$WORKFLOW_ID/blocker-slow"

wait_for_query_status "$TARGET_ID" "completed" "$TIMEOUT_SECONDS"
wait_for_query_status "$BLOCKER_ID" "running" "$TIMEOUT_SECONDS"

echo "repro: seeded workflow"
echo "workflow: $WORKFLOW_ID"
echo "completed target task: $TARGET_ID"
echo "running blocker task: $BLOCKER_ID"

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test node "$HEADLESS_CLIENT_JS" recreate-task "$BLOCKER_ID" \
  >"$BLOCKER_RECREATE_STDOUT" 2>"$BLOCKER_RECREATE_STDERR" &
BLOCKER_RECREATE_PID=$!

BLOCKER_RECREATE_INTENT_ID=""
for _ in {1..100}; do
  BLOCKER_RECREATE_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate-task\",\"$BLOCKER_ID\"%';")"
  if [[ -n "$BLOCKER_RECREATE_INTENT_ID" && "$BLOCKER_RECREATE_INTENT_ID" != "0" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$BLOCKER_RECREATE_INTENT_ID" ]]; then
  echo "repro: failed to capture blocker recreate-task intent id" >&2
  cat "$BLOCKER_RECREATE_STDERR" >&2 || true
  exit 1
fi

wait_for_intent_status "$BLOCKER_RECREATE_INTENT_ID" "running" 15

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test node "$HEADLESS_CLIENT_JS" recreate-task "$TARGET_ID" \
  >"$TARGET_RECREATE_STDOUT" 2>"$TARGET_RECREATE_STDERR" &
TARGET_RECREATE_PID=$!

TARGET_RECREATE_INTENT_ID=""
for _ in {1..100}; do
  TARGET_RECREATE_INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate-task\",\"$TARGET_ID\"%';")"
  if [[ -n "$TARGET_RECREATE_INTENT_ID" && "$TARGET_RECREATE_INTENT_ID" != "$BLOCKER_RECREATE_INTENT_ID" ]]; then
    break
  fi
  sleep 0.1
done

if [[ -z "$TARGET_RECREATE_INTENT_ID" || "$TARGET_RECREATE_INTENT_ID" == "$BLOCKER_RECREATE_INTENT_ID" ]]; then
  echo "repro: failed to capture target recreate-task intent id" >&2
  cat "$TARGET_RECREATE_STDERR" >&2 || true
  exit 1
fi

sleep 3

BLOCKER_RECREATE_STATUS="$(query_sqlite_value "select status from workflow_mutation_intents where id = $BLOCKER_RECREATE_INTENT_ID;")"
TARGET_RECREATE_STATUS="$(query_sqlite_value "select status from workflow_mutation_intents where id = $TARGET_RECREATE_INTENT_ID;")"
TARGET_PENDING_EVENTS="$(query_sqlite_value "select count(*) from events where task_id = '$TARGET_ID' and event_type = 'task.pending' and created_at >= (select created_at from workflow_mutation_intents where id = $TARGET_RECREATE_INTENT_ID);")"
TARGET_STATUS_AFTER_SECOND="$(query_sqlite_value "select status from tasks where id = '$TARGET_ID';")"
BLOCKER_STATUS_AFTER_SECOND="$(query_sqlite_value "select status from tasks where id = '$BLOCKER_ID';")"

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$BLOCKER_RECREATE_STATUS" != "running" ]]; then
    echo "repro: expected blocker recreate-task intent to still be running, got $BLOCKER_RECREATE_STATUS" >&2
    exit 1
  fi
  if [[ "$TARGET_RECREATE_STATUS" != "queued" ]]; then
    echo "repro: expected target recreate-task intent to be queued behind the running workflow mutation, got $TARGET_RECREATE_STATUS" >&2
    exit 1
  fi
  if [[ "$TARGET_PENDING_EVENTS" != "0" ]]; then
    echo "repro: expected no fresh task.pending events for $TARGET_ID after the delayed recreate-task was queued, saw $TARGET_PENDING_EVENTS" >&2
    exit 1
  fi
  if [[ "$TARGET_STATUS_AFTER_SECOND" != "completed" ]]; then
    echo "repro: expected $TARGET_ID to remain completed while recreate-task was queued, got $TARGET_STATUS_AFTER_SECOND" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
else
  if [[ "$BLOCKER_RECREATE_STATUS" != "failed" ]]; then
    echo "repro: expected blocker recreate-task intent to be superseded and failed, got $BLOCKER_RECREATE_STATUS" >&2
    exit 1
  fi
  if [[ "$TARGET_RECREATE_STATUS" != "running" && "$TARGET_RECREATE_STATUS" != "completed" ]]; then
    echo "repro: expected target recreate-task intent to take authority immediately, got $TARGET_RECREATE_STATUS" >&2
    exit 1
  fi
  if [[ "$TARGET_PENDING_EVENTS" == "0" ]]; then
    echo "repro: expected fresh task.pending events for $TARGET_ID after recreate-task took over, saw 0" >&2
    exit 1
  fi
  echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "blocker recreate-task intent: $BLOCKER_RECREATE_INTENT_ID status=$BLOCKER_RECREATE_STATUS"
echo "target recreate-task intent: $TARGET_RECREATE_INTENT_ID status=$TARGET_RECREATE_STATUS"
echo "task.pending events after target recreate-task enqueue: $TARGET_PENDING_EVENTS"
echo "task status after target recreate-task enqueue: $TARGET_ID=$TARGET_STATUS_AFTER_SECOND"
echo "task status after target recreate-task enqueue: $BLOCKER_ID=$BLOCKER_STATUS_AFTER_SECOND"
echo "tmp-dir: $TMP_DIR"

popd >/dev/null

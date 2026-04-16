#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MODE="both"
KEEP_TEMP=false
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-60}"
EXPECT="${REPRO_EXPECTATION:-fixed}"

for arg in "$@"; do
  case "$arg" in
    --mode=recreate) MODE="recreate" ;;
    --mode=retry-task) MODE="retry-task" ;;
    --mode=both) MODE="both" ;;
    --keep-temp) KEEP_TEMP=true ;;
    --expect-bug) EXPECT="bug" ;;
    --expect-fixed) EXPECT="fixed" ;;
    *)
      echo "usage: $0 [--mode=recreate|--mode=retry-task|--mode=both] [--expect-bug|--expect-fixed] [--keep-temp]" >&2
      exit 2
      ;;
  esac
done

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

cleanup_mode() {
  if [[ -n "${RESET_WRAPPER_PID:-}" ]]; then
    kill "$RESET_WRAPPER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${GUI_WRAPPER_PID:-}" ]]; then
    kill "$GUI_WRAPPER_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${GUI_PID:-}" ]]; then
    kill "$GUI_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${TMP_DIR:-}" && -d "${TMP_DIR:-}" && "$KEEP_TEMP" != true ]]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  fi
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

submit_workflow_with_retry() {
  local deadline
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))

  while (( $(date +%s) < deadline )); do
    : >"$SUBMIT_STDOUT"
    : >"$SUBMIT_STDERR"
    set +e
    HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
      >"$SUBMIT_STDOUT" 2>"$SUBMIT_STDERR"
    local submit_status=$?
    set -e
    WORKFLOW_ID="$(
      {
        sed -n 's/^Workflow ID: //p' "$SUBMIT_STDOUT"
        sed -n 's/^Delegated to GUI .*workflow: //p' "$SUBMIT_STDOUT"
      } | head -n1
    )"
    if [[ -n "$WORKFLOW_ID" ]]; then
      return 0
    fi

    if [[ "$submit_status" == "0" ]]; then
      sleep 0.2
      continue
    fi

    if rg -q 'requires an owner process|No request handler registered' "$SUBMIT_STDERR"; then
      sleep 0.2
      continue
    fi

    return "$submit_status"
  done

  return 1
}

run_mode() {
  local mode="$1"
  TMP_DIR="$(mktemp -d)"
  HOME_DIR="$TMP_DIR/home"
  DB_DIR="$HOME_DIR/.invoker"
  PLAN_PATH="$TMP_DIR/repro-plan.yaml"
  CONFIG_PATH="$DB_DIR/config.json"
  IPC_SOCKET_PATH="$DB_DIR/repro-ipc.sock"
  REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
  GUI_STDOUT="$TMP_DIR/gui.stdout.log"
  GUI_STDERR="$TMP_DIR/gui.stderr.log"
  SUBMIT_STDOUT="$TMP_DIR/submit.stdout.log"
  SUBMIT_STDERR="$TMP_DIR/submit.stderr.log"
  RESET_STDOUT="$TMP_DIR/reset.stdout.log"
  RESET_STDERR="$TMP_DIR/reset.stderr.log"
  MARKER_PATH="$TMP_DIR/after-reset.marker"

  mkdir -p "$DB_DIR"
  mkdir -p "$REPO_FIXTURE_DIR"

  git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
  git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
  git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
  printf 'stale-late-completion repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
  git -C "$REPO_FIXTURE_DIR" add README.md
  git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

  cat > "$CONFIG_PATH" <<'EOF'
{
  "maxConcurrency": 1
}
EOF

  cat > "$PLAN_PATH" <<EOF
name: Stale Late Completion After Reset Repro
repoUrl: $REPO_FIXTURE_DIR
tasks:
  - id: prepare
    description: Prepare
    command: >-
      bash -lc 'if [ -f "$MARKER_PATH" ]; then sleep 20; else sleep 0.2; fi'
  - id: mid
    description: Mid
    command: >-
      bash -lc 'sleep 0.2'
    dependencies: [prepare]
  - id: late-complete
    description: Late complete
    command: >-
      bash -lc 'sleep 6'
    dependencies: [mid]
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
    echo "repro: GUI owner failed to start for mode=$mode" >&2
    cat "$GUI_STDERR" >&2 || true
    return 1
  fi

  if ! submit_workflow_with_retry || [[ -z "${WORKFLOW_ID:-}" ]]; then
    echo "repro: failed to submit workflow for mode=$mode" >&2
    cat "$SUBMIT_STDOUT" >&2 || true
    cat "$SUBMIT_STDERR" >&2 || true
    return 1
  fi

  PREPARE_ID="$WORKFLOW_ID/prepare"
  MID_ID="$WORKFLOW_ID/mid"
  LATE_ID="$WORKFLOW_ID/late-complete"

  wait_for_query_status "$LATE_ID" "running" "$TIMEOUT_SECONDS"

  touch "$MARKER_PATH"
  RESET_STARTED_AT="$(date -u '+%Y-%m-%d %H:%M:%S')"

  case "$mode" in
    recreate)
      HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless recreate "$WORKFLOW_ID" \
        >"$RESET_STDOUT" 2>"$RESET_STDERR" &
      RESET_WRAPPER_PID=$!
      ;;
    retry-task)
      HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" --headless retry-task "$PREPARE_ID" \
        >"$RESET_STDOUT" 2>"$RESET_STDERR" &
      RESET_WRAPPER_PID=$!
      ;;
    *)
      echo "repro: unsupported mode=$mode" >&2
      return 1
      ;;
  esac

  sleep 0.5

  local observed=0
  local deadline
  deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
  while (( $(date +%s) < deadline )); do
    local late_status mid_status
    late_status="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$LATE_ID' limit 1;")"
    mid_status="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$MID_ID' limit 1;")"
    if [[ "$late_status" == "completed" && "$mid_status" == "pending" ]]; then
      observed=1
      break
    fi
    sleep 0.2
  done

  local reset_at completed_at running_between
  reset_at="$(query_sqlite_value "select created_at from events where task_id = '$LATE_ID' and event_type = 'task.pending' and created_at >= '$RESET_STARTED_AT' order by created_at asc limit 1;")"
  completed_at="$(query_sqlite_value "select created_at from events where task_id = '$LATE_ID' and event_type = 'task.completed' and created_at >= '$RESET_STARTED_AT' order by created_at asc limit 1;")"
  running_between=""
  if [[ -n "$reset_at" && -n "$completed_at" ]]; then
    running_between="$(query_sqlite_value "select count(*) from events where task_id = '$LATE_ID' and event_type = 'task.running' and created_at > '$reset_at' and created_at < '$completed_at';")"
  fi

  local current_prepare current_mid current_late
  current_prepare="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$PREPARE_ID' limit 1;")"
  current_mid="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$MID_ID' limit 1;")"
  current_late="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$LATE_ID' limit 1;")"

  local violation_observed=0
  if [[ "$observed" == "1" && -n "$reset_at" && -n "$completed_at" && "${running_between:-1}" == "0" ]]; then
    violation_observed=1
  fi

  if [[ "$EXPECT" == "bug" && "$violation_observed" != "1" ]]; then
    echo "repro: failed to reproduce stale late completion for mode=$mode" >&2
    echo "workflow=$WORKFLOW_ID prepare=$current_prepare mid=$current_mid late=$current_late reset_at=${reset_at:-<none>} completed_at=${completed_at:-<none>} running_between=${running_between:-<none>}" >&2
    echo "--- submit stdout ---" >&2
    cat "$SUBMIT_STDOUT" >&2 || true
    echo "--- submit stderr ---" >&2
    cat "$SUBMIT_STDERR" >&2 || true
    echo "--- reset stdout ---" >&2
    cat "$RESET_STDOUT" >&2 || true
    echo "--- reset stderr ---" >&2
    cat "$RESET_STDERR" >&2 || true
    echo "--- task rows ---" >&2
    sqlite3 "$DB_DIR/invoker.db" "select id,status,dependencies from tasks where workflow_id='$WORKFLOW_ID' order by id;" >&2 || true
    echo "--- event timeline ---" >&2
    sqlite3 "$DB_DIR/invoker.db" "select task_id,event_type,created_at from events where task_id in ('$PREPARE_ID','$MID_ID','$LATE_ID') order by created_at;" >&2 || true
    return 1
  fi

  if [[ "$EXPECT" == "fixed" && "$violation_observed" == "1" ]]; then
    echo "repro: stale late completion was still accepted for mode=$mode" >&2
    echo "workflow=$WORKFLOW_ID prepare=$current_prepare mid=$current_mid late=$current_late reset_at=${reset_at:-<none>} completed_at=${completed_at:-<none>} running_between=${running_between:-<none>}" >&2
    echo "--- submit stdout ---" >&2
    cat "$SUBMIT_STDOUT" >&2 || true
    echo "--- submit stderr ---" >&2
    cat "$SUBMIT_STDERR" >&2 || true
    echo "--- reset stdout ---" >&2
    cat "$RESET_STDOUT" >&2 || true
    echo "--- reset stderr ---" >&2
    cat "$RESET_STDERR" >&2 || true
    echo "--- task rows ---" >&2
    sqlite3 "$DB_DIR/invoker.db" "select id,status,dependencies from tasks where workflow_id='$WORKFLOW_ID' order by id;" >&2 || true
    echo "--- event timeline ---" >&2
    sqlite3 "$DB_DIR/invoker.db" "select task_id,event_type,created_at from events where task_id in ('$PREPARE_ID','$MID_ID','$LATE_ID') order by created_at;" >&2 || true
    return 1
  fi

  if [[ "$EXPECT" == "bug" ]]; then
    echo "repro: confirmed stale late completion after reset"
    echo "mode: $mode"
    echo "workflow: $WORKFLOW_ID"
    echo "reset task: $LATE_ID pending at $reset_at"
    echo "stale completion: $LATE_ID completed at $completed_at"
    echo "current prepare status: $current_prepare"
    echo "current mid status: $current_mid"
    echo "current late status: $current_late"
    echo "running events between reset and completion: $running_between"
  else
    echo "repro: confirmed stale late completion is rejected after reset"
    echo "mode: $mode"
    echo "workflow: $WORKFLOW_ID"
    echo "current prepare status: $current_prepare"
    echo "current mid status: $current_mid"
    echo "current late status: $current_late"
    echo "reset task: ${reset_at:-<none>}"
    echo "stale completion: ${completed_at:-<none>}"
    echo "running events between reset and completion: ${running_between:-<none>}"
  fi

  if [[ "$KEEP_TEMP" == true ]]; then
    echo "temp-dir: $TMP_DIR"
  fi
}

trap cleanup_mode EXIT

case "$MODE" in
  recreate)
    run_mode recreate
    ;;
  retry-task)
    run_mode retry-task
    ;;
  both)
    run_mode recreate
    cleanup_mode
    TMP_DIR=""
    GUI_WRAPPER_PID=""
    GUI_PID=""
    run_mode retry-task
    ;;
esac

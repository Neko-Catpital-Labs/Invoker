#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
KEEP_TEMP=false
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-120}"
DETAIL_MARKER="[provision] No package.json/pnpm-workspace.yaml found; skipping pnpm install"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-durable-failure-diagnostics-e2e.sh [--expect bug|fixed] [--keep-temp]

What it proves:
  This is a product-path durable diagnostics repro.

  1. Starts a real headless Invoker process with an isolated SQLite DB.
  2. Submits a real workflow whose task records concrete provision output and
     then sleeps.
  3. Waits until the task is running and the provision marker is durable in
     task_output.
  4. Terminates the owner process, exercising the real shutdown path.
  5. Asserts durable task output contains a [Shutdown Diagnostic] block, the
     running status, and the recent output marker, while the task row records
     the coarse "Application quit" terminal error.
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

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-durable-diagnostics.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REPO_FIXTURE_DIR="$TMP_DIR/repro-repo"
PLAN_PATH="$TMP_DIR/repro-plan.yaml"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
RUN_STDOUT="$TMP_DIR/run.stdout.log"
RUN_STDERR="$TMP_DIR/run.stderr.log"
IPC_SOCKET_PATH="$TMP_DIR/i.sock"

cleanup() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
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

wait_for_sql_count() {
  local sql="$1"
  local timeout="$2"
  local started_at
  started_at="$(date +%s)"
  while true; do
    local count
    count="$(query_sqlite_value "$sql" 2>/dev/null || echo 0)"
    if [[ "${count:-0}" != "0" ]]; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for sql count: $sql" >&2
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
    if grep -q 'owner-ipc-ready' "$DB_DIR/invoker.log" 2>/dev/null; then
      return 0
    fi
    if (( $(date +%s) - started_at >= timeout )); then
      echo "repro: timed out waiting for GUI owner IPC readiness" >&2
      cat "$OWNER_STDOUT" >&2 || true
      cat "$OWNER_STDERR" >&2 || true
      return 1
    fi
    sleep 0.1
  done
}

cd "$ROOT_DIR"

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi
if [[ ! -f packages/transport/dist/index.js ]]; then
  pnpm --filter @invoker/transport build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"
mkdir -p "$DB_DIR" "$REPO_FIXTURE_DIR"

git -C "$REPO_FIXTURE_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_FIXTURE_DIR" config user.name "Invoker Repro"
git -C "$REPO_FIXTURE_DIR" config user.email "repro@example.com"
printf 'durable diagnostics repro fixture\n' > "$REPO_FIXTURE_DIR/README.md"
git -C "$REPO_FIXTURE_DIR" add README.md
git -C "$REPO_FIXTURE_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$PLAN_PATH" <<EOF
name: Durable Failure Diagnostics E2E Repro
repoUrl: $REPO_FIXTURE_DIR
onFinish: none
tasks:
  - id: target
    description: Waits for owner shutdown after provision output is durable
    command: >-
      bash -lc 'sleep 120'
EOF

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" INVOKER_ENABLE_TEST_QUIT=1 NODE_ENV=test \
  "$ELECTRON_BIN" "$MAIN_JS" >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_PID=$!

wait_for_owner_ready 20

set +e
HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test \
  node "$HEADLESS_CLIENT_JS" --no-track run "$PLAN_PATH" >"$RUN_STDOUT" 2>"$RUN_STDERR"
RUN_STATUS=$?
set -e

WORKFLOW_ID="$(
  {
    sed -n 's/^Workflow ID: //p' "$RUN_STDOUT"
    sed -n 's/^Delegated to owner .*workflow: //p' "$RUN_STDOUT"
    sed -n 's/^Delegated to GUI .*workflow: //p' "$RUN_STDOUT"
  } | head -n1
)"

if [[ "$RUN_STATUS" -ne 0 || -z "${WORKFLOW_ID:-}" ]]; then
  echo "repro: failed to submit workflow" >&2
  cat "$RUN_STDOUT" >&2 || true
  cat "$RUN_STDERR" >&2 || true
  exit 1
fi

TASK_ID="$WORKFLOW_ID/target"
wait_for_sql_count "select count(*) from tasks where id = '$TASK_ID' and status = 'running';" "$TIMEOUT_SECONDS"
wait_for_sql_count "select count(*) from task_output where task_id = '$TASK_ID' and data like '%$DETAIL_MARKER%';" "$TIMEOUT_SECONDS"

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test \
  node --input-type=module -e "
    import { IpcBus } from './packages/transport/dist/index.js';
    const bus = new IpcBus(undefined, { allowServe: false });
    await bus.ready();
    await bus.request('invoker:test-quit-owner', {});
    bus.disconnect();
  "
wait "$OWNER_PID" >/dev/null 2>&1 || true
OWNER_PID=""
sleep 1

OUTPUT="$(query_sqlite_value "select group_concat(data, char(10)) from task_output where task_id = '$TASK_ID' order by id;")"
TASK_STATUS="$(query_sqlite_value "select coalesce(status,'') from tasks where id = '$TASK_ID';")"
TASK_ERROR="$(query_sqlite_value "select coalesce(error,'') from tasks where id = '$TASK_ID';")"

HAS_DIAGNOSTIC=0
HAS_STATUS=0
HAS_MARKER=0
HAS_APP_QUIT=0
[[ "$OUTPUT" == *"[Shutdown Diagnostic]"* ]] && HAS_DIAGNOSTIC=1
[[ "$OUTPUT" == *"status=running"* ]] && HAS_STATUS=1
[[ "$OUTPUT" == *"$DETAIL_MARKER"* ]] && HAS_MARKER=1
[[ "$TASK_ERROR" == *"Application quit"* ]] && HAS_APP_QUIT=1

if [[ "$EXPECTATION" == "bug" ]]; then
  if [[ "$HAS_DIAGNOSTIC" == "1" && "$HAS_MARKER" == "1" ]]; then
    echo "repro: expected durable diagnostics to be missing, but they were present" >&2
    exit 1
  fi
  echo "repro: confirmed bug"
else
  if [[ "$HAS_DIAGNOSTIC" != "1" || "$HAS_STATUS" != "1" || "$HAS_MARKER" != "1" || "$HAS_APP_QUIT" != "1" ]]; then
    echo "repro: expected durable shutdown diagnostic with concrete marker and Application quit row error" >&2
    echo "has_diagnostic=$HAS_DIAGNOSTIC has_status=$HAS_STATUS has_marker=$HAS_MARKER has_app_quit=$HAS_APP_QUIT" >&2
    exit 1
  fi
  echo "repro: confirmed fix"
fi

echo "workflow: $WORKFLOW_ID"
echo "task: $TASK_ID status=$TASK_STATUS"
echo "task error: $TASK_ERROR"
echo "has shutdown diagnostic: $HAS_DIAGNOSTIC"
echo "has status line: $HAS_STATUS"
echo "has concrete marker: $HAS_MARKER"
echo "tmp-dir: $TMP_DIR"

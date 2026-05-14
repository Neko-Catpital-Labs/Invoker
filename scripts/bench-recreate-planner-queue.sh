#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TASK_COUNT="${TASK_COUNT:-20}"
TIMEOUT_SECONDS="${BENCH_TIMEOUT_SECONDS:-120}"
KEEP_TEMP="${KEEP_TEMP:-false}"
SKIP_BUILD="${SKIP_BUILD:-false}"

case "${1:-}" in
  -h|--help)
    cat <<'EOF'
Usage: TASK_COUNT=20 scripts/bench-recreate-planner-queue.sh

Reports:
  mutationCompletionMs: recreate request start until workflow mutation intent completes
  replacementEnqueueMs: recreate request start until first replacement selected attempt is pending/claimed/running/completed
  executorLaunchMs:     first replacement attempt claimed_at until last replacement task launch_completed_at

The benchmark uses an isolated temp HOME/DB/socket/repo and a standalone owner
plus headless client path. Run it on a baseline checkout and this branch with
the same TASK_COUNT/environment for before/after comparison.
EOF
    exit 0
    ;;
esac

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "sqlite3 is required" >&2
  exit 1
fi

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-recreate-bench.XXXXXX")"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
PLAN_PATH="$TMP_DIR/bench-plan.yaml"
REPO_DIR="$TMP_DIR/repo"
IPC_SOCKET_PATH="$DB_DIR/bench-ipc.sock"
OWNER_STDOUT="$TMP_DIR/owner.stdout.log"
OWNER_STDERR="$TMP_DIR/owner.stderr.log"
RUN_STDOUT="$TMP_DIR/run.stdout.log"
RUN_STDERR="$TMP_DIR/run.stderr.log"
RECREATE_STDOUT="$TMP_DIR/recreate.stdout.log"
RECREATE_STDERR="$TMP_DIR/recreate.stderr.log"

cleanup() {
  if [[ -n "${RECREATE_PID:-}" ]]; then
    kill "$RECREATE_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${OWNER_WRAPPER_PID:-}" ]]; then
    kill "$OWNER_WRAPPER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TEMP" != "true" ]]; then
    rm -rf "$TMP_DIR" >/dev/null 2>&1 || true
  else
    echo "kept temp: $TMP_DIR" >&2
  fi
}
trap cleanup EXIT

query_sqlite_value() {
  sqlite3 -noheader "$DB_DIR/invoker.db" "$1"
}

wait_for_sql() {
  local sql="$1"
  local expected="$2"
  local label="$3"
  local started_at
  started_at="$(now_ms)"
  while true; do
    local value
    value="$(query_sqlite_value "$sql" 2>/dev/null || true)"
    if [[ "$value" == "$expected" ]]; then
      return 0
    fi
    if (( $(now_ms) - started_at > TIMEOUT_SECONDS * 1000 )); then
      echo "timed out waiting for $label (last=$value)" >&2
      return 1
    fi
    sleep 0.05
  done
}

mkdir -p "$DB_DIR" "$REPO_DIR"

pushd "$ROOT_DIR" >/dev/null

if [[ "$SKIP_BUILD" != "true" ]]; then
  pnpm --filter @invoker/app build >/dev/null
elif [[ ! -f packages/app/dist/main.js ]]; then
  echo "packages/app/dist/main.js is missing; unset SKIP_BUILD or build the app first" >&2
  exit 1
fi

git -C "$REPO_DIR" init -b main >/dev/null 2>&1
git -C "$REPO_DIR" config user.name "Invoker Bench"
git -C "$REPO_DIR" config user.email "bench@example.com"
printf 'recreate benchmark fixture\n' > "$REPO_DIR/README.md"
git -C "$REPO_DIR" add README.md
git -C "$REPO_DIR" commit -m "Initial fixture" >/dev/null 2>&1

cat > "$DB_DIR/config.json" <<EOF
{
  "maxConcurrency": $TASK_COUNT
}
EOF

{
  echo "name: Recreate Planner Queue Benchmark"
  echo "repoUrl: $REPO_DIR"
  echo "onFinish: none"
  echo "tasks:"
  for i in $(seq 1 "$TASK_COUNT"); do
    echo "  - id: root-$i"
    echo "    description: Independent root $i"
    echo "    command: >-"
    echo "      bash -lc 'printf root-$i > bench-$i.txt'"
  done
} > "$PLAN_PATH"

ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" \
  >"$OWNER_STDOUT" 2>"$OWNER_STDERR" &
OWNER_WRAPPER_PID=$!

for _ in {1..300}; do
  if [[ -f "$DB_DIR/invoker.db.lock/pid" ]]; then
    OWNER_PID="$(cat "$DB_DIR/invoker.db.lock/pid" 2>/dev/null || true)"
    if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
      break
    fi
  fi
  sleep 0.05
done

if [[ -z "${OWNER_PID:-}" ]] || ! kill -0 "$OWNER_PID" >/dev/null 2>&1; then
  echo "owner failed to start" >&2
  cat "$OWNER_STDERR" >&2 || true
  exit 1
fi

HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" \
  --headless run "$PLAN_PATH" >"$RUN_STDOUT" 2>"$RUN_STDERR"

WORKFLOW_ID="$(
  {
    sed -n 's/^Workflow ID: //p' "$RUN_STDOUT"
    sed -n 's/^Delegated to owner .*workflow: //p' "$RUN_STDOUT"
    sed -n 's/^Delegated to GUI .*workflow: //p' "$RUN_STDOUT"
  } | head -n1
)"

if [[ -z "${WORKFLOW_ID:-}" ]]; then
  echo "failed to capture workflow id" >&2
  cat "$RUN_STDOUT" >&2 || true
  cat "$RUN_STDERR" >&2 || true
  exit 1
fi

wait_for_sql "select count(*) from tasks where workflow_id = '$WORKFLOW_ID' and is_merge_node = 0 and status = 'completed';" "$TASK_COUNT" "initial completion"
BASE_GENERATION="$(query_sqlite_value "select min(execution_generation) from tasks where workflow_id = '$WORKFLOW_ID' and is_merge_node = 0;")"
NEXT_GENERATION="$((BASE_GENERATION + 1))"

START_MS="$(now_ms)"
HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET_PATH" NODE_ENV=test "$ELECTRON_BIN" "$MAIN_JS" \
  --headless --no-track recreate "$WORKFLOW_ID" >"$RECREATE_STDOUT" 2>"$RECREATE_STDERR" &
RECREATE_PID=$!

INTENT_ID=""
for _ in {1..300}; do
  INTENT_ID="$(query_sqlite_value "select coalesce(max(id),'') from workflow_mutation_intents where workflow_id = '$WORKFLOW_ID' and args_json like '%\"recreate\",\"$WORKFLOW_ID\"%';" 2>/dev/null || true)"
  [[ -n "$INTENT_ID" && "$INTENT_ID" != "0" ]] && break
  sleep 0.05
done

if [[ -z "$INTENT_ID" || "$INTENT_ID" == "0" ]]; then
  echo "failed to capture recreate intent" >&2
  cat "$RECREATE_STDOUT" >&2 || true
  cat "$RECREATE_STDERR" >&2 || true
  exit 1
fi

REPLACEMENT_ENQUEUE_MS=""
MUTATION_COMPLETION_MS=""
POLL_START_MS="$(now_ms)"
while true; do
  now="$(now_ms)"
  if [[ -z "$REPLACEMENT_ENQUEUE_MS" ]]; then
    count="$(query_sqlite_value "select count(*) from tasks t join attempts a on a.id = t.selected_attempt_id where t.workflow_id = '$WORKFLOW_ID' and t.is_merge_node = 0 and t.execution_generation >= $NEXT_GENERATION and a.status in ('pending','claimed','running','completed');" 2>/dev/null || true)"
    if [[ "${count:-0}" != "0" ]]; then
      REPLACEMENT_ENQUEUE_MS="$((now - START_MS))"
    fi
  fi

  intent_status="$(query_sqlite_value "select coalesce(status,'') from workflow_mutation_intents where id = $INTENT_ID;" 2>/dev/null || true)"
  if [[ "$intent_status" == "completed" && -z "$MUTATION_COMPLETION_MS" ]]; then
    MUTATION_COMPLETION_MS="$((now - START_MS))"
  fi

  if [[ -n "$REPLACEMENT_ENQUEUE_MS" && -n "$MUTATION_COMPLETION_MS" ]]; then
    break
  fi
  if (( now - POLL_START_MS > TIMEOUT_SECONDS * 1000 )); then
    echo "timed out waiting for recreate metrics (intent=$intent_status enqueueMs=${REPLACEMENT_ENQUEUE_MS:-})" >&2
    exit 1
  fi
  sleep 0.02
done

wait_for_sql "select count(*) from tasks where workflow_id = '$WORKFLOW_ID' and is_merge_node = 0 and execution_generation >= $NEXT_GENERATION and launch_completed_at is not null;" "$TASK_COUNT" "replacement launch completion"

if ! wait "$RECREATE_PID"; then
  echo "recreate command failed" >&2
  cat "$RECREATE_STDOUT" >&2 || true
  cat "$RECREATE_STDERR" >&2 || true
  exit 1
fi
unset RECREATE_PID

EXECUTOR_LAUNCH_MS="$(query_sqlite_value "select cast(round((julianday(max(t.launch_completed_at)) - julianday(min(a.claimed_at))) * 86400000.0) as integer) from tasks t join attempts a on a.id = t.selected_attempt_id where t.workflow_id = '$WORKFLOW_ID' and t.is_merge_node = 0 and t.execution_generation >= $NEXT_GENERATION and a.claimed_at is not null and t.launch_completed_at is not null;")"

cat <<EOF
benchmark=recreate-planner-queue
taskCount=$TASK_COUNT
workflowId=$WORKFLOW_ID
intentId=$INTENT_ID
mutationCompletionMs=$MUTATION_COMPLETION_MS
replacementEnqueueMs=$REPLACEMENT_ENQUEUE_MS
executorLaunchMs=$EXECUTOR_LAUNCH_MS
EOF

popd >/dev/null

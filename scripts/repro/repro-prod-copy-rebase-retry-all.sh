#!/usr/bin/env bash
# Repro/verification for production-shaped bulk rebase-recreate.
#
# Copies the local production DB into an isolated temp INVOKER_DB_DIR, marks
# copied workflows/tasks failed, then runs the real scripts/rebase-retry-all.sh
# path against a standalone owner. The production DB is never mutated.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"

SOURCE_DB="${INVOKER_PROD_DB_SOURCE:-$HOME/.invoker/invoker.db}"
TIMEOUT_SECONDS="${REPRO_TIMEOUT_SECONDS:-600}"
PARALLELISM="${REPRO_PARALLELISM:-12}"
COMMAND_TIMEOUT_SECONDS="${REPRO_COMMAND_TIMEOUT_SECONDS:-120}"
KEEP_TMP="${REPRO_KEEP_TMP:-0}"
PRESERVE_TASK_COMMANDS="${REPRO_PRESERVE_TASK_COMMANDS:-0}"
SKIP_BUILD="${REPRO_SKIP_BUILD:-0}"

if [[ ! -f "$SOURCE_DB" ]]; then
  echo "FAIL: production DB not found: $SOURCE_DB" >&2
  exit 1
fi
if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "FAIL: sqlite3 is required" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d -t invoker-prod-rebase-repro.XXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$TMP_DIR/db"
LOG_DIR="$TMP_DIR/logs"
IPC_SOCKET="/tmp/invoker-prod-rebase-repro-$$.sock"
OWNER_LOG="$LOG_DIR/owner.log"
BULK_LOG="$LOG_DIR/rebase-retry-all.log"
mkdir -p "$HOME_DIR/.invoker" "$DB_DIR" "$LOG_DIR"

OWNER_PID=""
cleanup() {
  if [[ -n "${OWNER_PID:-}" ]] && kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    kill "$OWNER_PID" >/dev/null 2>&1 || true
    wait "$OWNER_PID" >/dev/null 2>&1 || true
  fi
  if [[ "$KEEP_TMP" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "Kept temp repro dir: $TMP_DIR" >&2
  fi
  rm -f "$IPC_SOCKET"
}
trap cleanup EXIT

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "$seconds" "$@"
  else
    python3 - "$seconds" "$@" <<'PY'
import subprocess
import sys

timeout = int(sys.argv[1])
cmd = sys.argv[2:]
try:
    raise SystemExit(subprocess.run(cmd, timeout=timeout).returncode)
except subprocess.TimeoutExpired:
    print(f"Timed out after {timeout}s: {' '.join(cmd)}", file=sys.stderr)
    raise SystemExit(124)
PY
  fi
}

probe_exec_endpoint() {
  node - <<'JS'
const path = require('node:path');

(async () => {
  const repoRoot = process.cwd();
  const mod = await import(path.join(repoRoot, 'packages', 'transport', 'dist', 'index.js'));
  const bus = new mod.IpcBus(undefined, { allowServe: false });
  await bus.ready();
  try {
    await Promise.race([
      bus.request('headless.exec', { args: ['__endpoint_probe__'], noTrack: true }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('probe timeout')), 1000)),
    ]);
    process.exitCode = 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Unknown command: __endpoint_probe__/.test(message)) {
      process.exitCode = 0;
    } else {
      process.stderr.write(message + '\n');
      process.exitCode = 1;
    }
  } finally {
    bus.disconnect();
  }
})().catch((error) => {
  process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
  process.exitCode = 1;
});
JS
}

now_ms() {
  python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
}

echo "==> copying production DB into isolated repro DB"
sqlite3 "$SOURCE_DB" ".backup '$DB_DIR/invoker.db'"

cat > "$HOME_DIR/.invoker/config.json" <<'JSON'
{
  "allowGraphMutation": true,
  "disableAutoRunOnStartup": true,
  "maxConcurrency": 12,
  "autoFixRetries": 0
}
JSON

echo "==> normalizing copied DB to failed-workload state"
sqlite3 "$DB_DIR/invoker.db" <<SQL
delete from workflow_mutation_intents;
delete from workflow_mutation_leases;
update workflows
set status = 'failed',
    updated_at = datetime('now');
update tasks
set status = 'failed',
    exit_code = 1,
    error = 'prod-copy bulk recreate repro synthetic failure',
    launch_phase = null,
    launch_started_at = null,
    launch_completed_at = null,
    started_at = null,
    completed_at = datetime('now'),
    last_heartbeat_at = null,
    selected_attempt_id = null,
    is_fixing_with_ai = 0,
    pending_fix_error = null;
update attempts
set status = 'failed',
    claimed_at = null,
    started_at = null,
    completed_at = datetime('now'),
    exit_code = 1,
    error = 'prod-copy bulk recreate repro synthetic failure',
    last_heartbeat_at = null,
    lease_expires_at = null;
SQL

if [[ "$PRESERVE_TASK_COMMANDS" != "1" ]]; then
  sqlite3 "$DB_DIR/invoker.db" <<'SQL'
update tasks
set command = 'true',
    prompt = coalesce(prompt, 'prod-copy bulk recreate repro noop prompt')
where is_merge_node = 0;
SQL
fi

WORKFLOW_COUNT="$(sqlite3 "$DB_DIR/invoker.db" "select count(*) from workflows;")"
TASK_COUNT="$(sqlite3 "$DB_DIR/invoker.db" "select count(*) from tasks;")"
FINAL_WORKFLOW_ID="$(sqlite3 "$DB_DIR/invoker.db" "select id from workflows order by id desc limit 1;")"
echo "==> copied workload: workflows=$WORKFLOW_COUNT tasks=$TASK_COUNT finalWorkflow=$FINAL_WORKFLOW_ID"

ELECTRON="$REPO_ROOT/scripts/electron.cjs"
MAIN="$REPO_ROOT/packages/app/dist/main.js"
if [[ "$SKIP_BUILD" != "1" ]]; then
  echo "==> building current transport/app dist"
  pnpm --filter @invoker/transport build >/dev/null
  pnpm --filter @invoker/app build >/dev/null
elif [[ ! -f "$MAIN" ]]; then
  echo "==> building app dist"
  pnpm --filter @invoker/app build >/dev/null
fi

echo "==> starting standalone owner"
HOME="$HOME_DIR" \
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_IPC_SOCKET="$IPC_SOCKET" \
INVOKER_HEADLESS_STANDALONE=1 \
INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS=900000 \
INVOKER_CLAUDE_COMMAND="${INVOKER_CLAUDE_COMMAND:-/usr/bin/true}" \
INVOKER_CLAUDE_FIX_COMMAND="${INVOKER_CLAUDE_FIX_COMMAND:-/usr/bin/true}" \
INVOKER_GIT_NETWORK_TIMEOUT_MS="${INVOKER_GIT_NETWORK_TIMEOUT_MS:-120000}" \
NODE_ENV=test \
"$ELECTRON" "$MAIN" --headless owner-serve >"$OWNER_LOG" 2>&1 &
OWNER_PID="$!"

for _ in $(seq 1 120); do
  if ! kill -0 "$OWNER_PID" >/dev/null 2>&1; then
    echo "FAIL: owner exited before ready" >&2
    cat "$OWNER_LOG" >&2 || true
    exit 1
  fi
  if grep -q 'standalone owner ready' "$OWNER_LOG" 2>/dev/null && [[ -e "$IPC_SOCKET" ]]; then
    break
  fi
  sleep 0.25
done
if ! grep -q 'standalone owner ready' "$OWNER_LOG" 2>/dev/null; then
  echo "FAIL: owner never became ready" >&2
  cat "$OWNER_LOG" >&2 || true
  exit 1
fi

for _ in $(seq 1 80); do
  if HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET" probe_exec_endpoint >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
if ! HOME="$HOME_DIR" INVOKER_DB_DIR="$DB_DIR" INVOKER_IPC_SOCKET="$IPC_SOCKET" probe_exec_endpoint >/tmp/invoker-prod-rebase-probe.out 2>&1; then
  echo "FAIL: owner headless.exec endpoint never became ready" >&2
  cat /tmp/invoker-prod-rebase-probe.out >&2 || true
  cat "$OWNER_LOG" >&2 || true
  exit 1
fi

echo "==> running scripts/rebase-retry-all.sh against prod-copy DB"
START_MS="$(now_ms)"
set +e
HOME="$HOME_DIR" \
INVOKER_DB_DIR="$DB_DIR" \
INVOKER_IPC_SOCKET="$IPC_SOCKET" \
INVOKER_CLAUDE_COMMAND="${INVOKER_CLAUDE_COMMAND:-/usr/bin/true}" \
INVOKER_CLAUDE_FIX_COMMAND="${INVOKER_CLAUDE_FIX_COMMAND:-/usr/bin/true}" \
INVOKER_GIT_NETWORK_TIMEOUT_MS="${INVOKER_GIT_NETWORK_TIMEOUT_MS:-120000}" \
NODE_ENV=test \
run_with_timeout "$TIMEOUT_SECONDS" \
  bash "$REPO_ROOT/scripts/rebase-retry-all.sh" \
    --status failed \
    --parallel "$PARALLELISM" \
    --timeout "$COMMAND_TIMEOUT_SECONDS" \
  >"$BULK_LOG" 2>&1
STATUS=$?
set -e
DISPATCH_END_MS="$(now_ms)"
DISPATCH_ELAPSED_MS=$((DISPATCH_END_MS - START_MS))

if [[ "$STATUS" -ne 0 ]]; then
  echo "FAIL: rebase-retry-all exited $STATUS after ${DISPATCH_ELAPSED_MS}ms" >&2
  tail -n 120 "$BULK_LOG" >&2 || true
  echo "owner log:" >&2
  tail -n 120 "$OWNER_LOG" >&2 || true
  exit "$STATUS"
fi

INTENT_TOTAL=0
INTENT_COMPLETED=0
INTENT_RUNNING=0
INTENT_QUEUED=0
INTENT_FAILED=0

while true; do
  read -r INTENT_TOTAL INTENT_COMPLETED INTENT_RUNNING INTENT_QUEUED INTENT_FAILED < <(
    sqlite3 "$DB_DIR/invoker.db" "
      select
        count(*),
        sum(case when status = 'completed' then 1 else 0 end),
        sum(case when status = 'running' then 1 else 0 end),
        sum(case when status = 'queued' then 1 else 0 end),
        sum(case when status = 'failed' then 1 else 0 end)
      from workflow_mutation_intents
      where args_json like '%rebase-recreate%';
    " | tr '|' ' '
  )
  NOW_MS="$(now_ms)"
  if [[ "$INTENT_TOTAL" -eq "$WORKFLOW_COUNT" && "$INTENT_COMPLETED" -eq "$WORKFLOW_COUNT" && "$INTENT_RUNNING" -eq 0 && "$INTENT_QUEUED" -eq 0 && "$INTENT_FAILED" -eq 0 ]]; then
    break
  fi
  if [[ $(((NOW_MS - START_MS) / 1000)) -ge "$TIMEOUT_SECONDS" ]]; then
    echo "FAIL: mutation queue did not drain before ${TIMEOUT_SECONDS}s: total=$INTENT_TOTAL completed=$INTENT_COMPLETED running=$INTENT_RUNNING queued=$INTENT_QUEUED failed=$INTENT_FAILED" >&2
    tail -n 120 "$BULK_LOG" >&2 || true
    echo "owner log:" >&2
    tail -n 160 "$OWNER_LOG" >&2 || true
    exit 1
  fi
  sleep 1
done
DRAIN_END_MS="$(now_ms)"
DRAIN_ELAPSED_MS=$((DRAIN_END_MS - START_MS))

FINAL_STATUS="$(sqlite3 "$DB_DIR/invoker.db" "
  select coalesce(status, '')
  from workflow_mutation_intents
  where workflow_id = '$FINAL_WORKFLOW_ID'
    and args_json like '%rebase-recreate%'
  order by id desc
  limit 1;
")"

MAX_INTENT_MS="$(sqlite3 "$DB_DIR/invoker.db" "
  select coalesce(cast(round(max((julianday(completed_at) - julianday(started_at)) * 86400000.0)) as integer), 0)
  from workflow_mutation_intents
  where args_json like '%rebase-recreate%'
    and started_at is not null
    and completed_at is not null;
")"

if [[ "$INTENT_TOTAL" -ne "$WORKFLOW_COUNT" ]]; then
  echo "FAIL: expected $WORKFLOW_COUNT rebase-recreate intents, found $INTENT_TOTAL" >&2
  exit 1
fi
if [[ "$INTENT_COMPLETED" -ne "$WORKFLOW_COUNT" || "$INTENT_RUNNING" -ne 0 || "$INTENT_QUEUED" -ne 0 || "$INTENT_FAILED" -ne 0 ]]; then
  echo "FAIL: mutation queue did not drain: completed=$INTENT_COMPLETED running=$INTENT_RUNNING queued=$INTENT_QUEUED failed=$INTENT_FAILED" >&2
  exit 1
fi
if [[ "$FINAL_STATUS" != "completed" ]]; then
  echo "FAIL: final workflow $FINAL_WORKFLOW_ID intent status is '$FINAL_STATUS'" >&2
  exit 1
fi

echo "PASS prod-copy rebase-retry-all"
echo "  workflows: $WORKFLOW_COUNT"
echo "  tasks: $TASK_COUNT"
echo "  dispatchWallMs: $DISPATCH_ELAPSED_MS"
echo "  queueDrainWallMs: $DRAIN_ELAPSED_MS"
echo "  maxIntentMs: $MAX_INTENT_MS"
echo "  finalWorkflow: $FINAL_WORKFLOW_ID"
echo "  finalWorkflowIntentStatus: $FINAL_STATUS"
echo "  logs: $LOG_DIR"

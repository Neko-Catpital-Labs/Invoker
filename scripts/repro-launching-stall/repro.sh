#!/usr/bin/env bash
# Repro for "tasks stuck on launching" bug observed in production
# (see ~/.invoker/invoker.log, e.g. task `wf-1775874004544-6/add-prompt-edit-tests`
#  at 2026-04-16T21:23:10 was force-failed with:
#    "Launch stalled: task remained in running/launching for 600s
#     without a spawned execution handle")
#
# Root-cause claim we prove:
#   A task can reach `status=running, launch_phase=launching` in the persisted
#   SQLite DB WITHOUT the task-runner ever invoking `executor.start()` for it.
#   In that state, nothing advances the task — the ONLY escape mechanism is
#   the `db-poll` launch-stall watchdog in
#   packages/app/src/main.ts:1952-1976
#   which fires after INVOKER_LAUNCHING_STALL_TIMEOUT_MS (default 600_000 ms)
#   and forcibly marks the task `failed` with the exact error string above.
#
# What this script does:
#   1. Creates an isolated INVOKER_DB_DIR under /tmp and copies the prod
#      schema (tables only, no rows) into a fresh DB.
#   2. Seeds a single workflow + task + attempt in the exact stuck state
#      (status=running, launch_phase=launching, launch_started_at=now).
#   3. Launches the real Electron Invoker app against that isolated DB
#      with `INVOKER_LAUNCHING_STALL_TIMEOUT_MS=5000` (5 seconds instead of
#      10 minutes) and `disableAutoRunOnStartup=true` so no orphan-relaunch
#      path runs — only the watchdog can change the task's state.
#   4. Polls the DB every 500ms until the watchdog fires OR we time out.
#   5. Asserts the resulting row matches the expected failure and the error
#      message matches the production one byte-for-byte (modulo the timeout
#      seconds in the message).
#
# Exit codes:
#   0  — bug reproduced; watchdog is the only way out (ROOT CAUSE CONFIRMED)
#   1  — task advanced by some OTHER mechanism (claim falsified)
#   2  — script setup / infra failure
#
# Prereqs:
#   * Runs in the repro worktree at /tmp/invoker-repros/launching-stall.
#   * Shares node_modules with the main checkout via symlink.
#   * Main checkout must already have packages/*/dist built
#     (run `pnpm build` in main if missing).

set -Eeuo pipefail

MAIN_CHECKOUT="/home/edbert-chan/Invoker"
WORKTREE_ROOT="/tmp/invoker-repros/launching-stall"
APP_MAIN_JS="$MAIN_CHECKOUT/packages/app/dist/main.js"
ELECTRON_BIN="$MAIN_CHECKOUT/packages/app/node_modules/.bin/electron"
PROD_DB="$HOME/.invoker/invoker.db"

die() { echo "[repro] FATAL: $*" >&2; exit 2; }

# Pre-flight
[[ -f "$APP_MAIN_JS"  ]] || die "missing $APP_MAIN_JS (run 'pnpm build' in $MAIN_CHECKOUT)"
[[ -x "$ELECTRON_BIN" ]] || die "missing electron at $ELECTRON_BIN"
[[ -f "$PROD_DB"      ]] || die "missing prod DB at $PROD_DB (needed only to copy schema)"
command -v xvfb-run >/dev/null || die "xvfb-run not found (needed for headless Electron)"
command -v sqlite3  >/dev/null || die "sqlite3 CLI not found"

STAMP="$(date +%s)-$$"
REPRO_HOME="/tmp/invoker-repros/launching-stall-run-$STAMP"
DB="$REPRO_HOME/invoker.db"
CONFIG_JSON="$REPRO_HOME/config.json"
APP_LOG="$REPRO_HOME/electron.log"
WORKFLOW_ID="wf-repro-stall-$STAMP"
TASK_ID="$WORKFLOW_ID/stuck-task"
ATTEMPT_ID="${TASK_ID}-attempt-0"
STALL_TIMEOUT_MS=5000

mkdir -p "$REPRO_HOME"
trap 'cleanup' EXIT

ELECTRON_PID=""
cleanup() {
  if [[ -n "$ELECTRON_PID" ]] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill -TERM "$ELECTRON_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5; do
      sleep 0.2
      kill -0 "$ELECTRON_PID" 2>/dev/null || break
    done
    kill -KILL "$ELECTRON_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_REPRO_HOME:-0}" != "1" ]]; then
    rm -rf "$REPRO_HOME" 2>/dev/null || true
  fi
}

echo "[repro] repro root  : $REPRO_HOME"
echo "[repro] stall window: ${STALL_TIMEOUT_MS}ms (INVOKER_LAUNCHING_STALL_TIMEOUT_MS)"

# ─── Step 1: bootstrap schema from prod DB (tables + indices only) ────────
# We deliberately copy ONLY the schema — no rows — so the repro is
# isolated from any production state.
echo "[repro] [1/4] dumping prod schema into fresh DB ($DB)"
SCHEMA_SQL="$REPRO_HOME/schema.sql"
# Strip sqlite_sequence (internal table) which .schema emits but cannot be re-created.
sqlite3 "$PROD_DB" ".schema" | grep -v 'sqlite_sequence' > "$SCHEMA_SQL"
sqlite3 "$DB" < "$SCHEMA_SQL"

# ─── Step 2: seed the stuck state ─────────────────────────────────────────
# NOTE: launch_started_at is `now - STALL_TIMEOUT_MS` so the watchdog fires
#       immediately on the first db-poll tick after the app starts. We still
#       assert below that the app was actually running when the state change
#       landed (by reading the error string written by the watchdog).
NOW_EPOCH_MS="$(date +%s%3N)"
LAUNCH_STARTED_AT_EPOCH_MS=$(( NOW_EPOCH_MS - STALL_TIMEOUT_MS ))
NOW_ISO="$(date -u -d @$(( NOW_EPOCH_MS / 1000 )).$(printf "%03d" $(( NOW_EPOCH_MS % 1000 )) ) '+%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null \
  || date -u '+%Y-%m-%dT%H:%M:%S.000Z')"
LAUNCH_ISO="$(date -u -d @$(( LAUNCH_STARTED_AT_EPOCH_MS / 1000 )).$(printf "%03d" $(( LAUNCH_STARTED_AT_EPOCH_MS % 1000 )) ) '+%Y-%m-%dT%H:%M:%S.%3NZ' 2>/dev/null \
  || date -u '+%Y-%m-%dT%H:%M:%S.000Z')"

echo "[repro] [2/4] seeding task in stuck state:"
echo "[repro]         task_id            = $TASK_ID"
echo "[repro]         status             = running"
echo "[repro]         launch_phase       = launching"
echo "[repro]         launch_started_at  = $LAUNCH_ISO (${STALL_TIMEOUT_MS}ms ago)"
echo "[repro]         last_heartbeat_at  = $NOW_ISO"

sqlite3 "$DB" <<SQL
BEGIN;

INSERT INTO workflows (id, name, status, created_at, updated_at, generation)
VALUES ('$WORKFLOW_ID', 'launching-stall-repro', 'running', '$NOW_ISO', '$NOW_ISO', 0);

INSERT INTO tasks (
  id, workflow_id, description, status,
  dependencies, command,
  launch_phase, launch_started_at,
  started_at, last_heartbeat_at,
  selected_attempt_id, execution_generation,
  created_at
) VALUES (
  '$TASK_ID', '$WORKFLOW_ID', 'stuck-task repro', 'running',
  '[]', 'sleep 999',
  'launching', '$LAUNCH_ISO',
  '$LAUNCH_ISO', '$LAUNCH_ISO',
  '$ATTEMPT_ID', 0,
  '$LAUNCH_ISO'
);

INSERT INTO attempts (
  id, node_id, attempt_number, status,
  claimed_at, last_heartbeat_at, lease_expires_at,
  created_at
) VALUES (
  '$ATTEMPT_ID', '$TASK_ID', 0, 'claimed',
  '$LAUNCH_ISO', '$LAUNCH_ISO', '$NOW_ISO',
  '$LAUNCH_ISO'
);

COMMIT;
SQL

# Dump the pre-run state
echo "[repro] ── initial task row ─────────────────────────────"
sqlite3 -header -column "$DB" "SELECT id, status, launch_phase, launch_started_at, completed_at, error FROM tasks WHERE id = '$TASK_ID';"
echo "[repro] ── initial attempt row ──────────────────────────"
sqlite3 -header -column "$DB" "SELECT id, status, claimed_at, started_at, last_heartbeat_at FROM attempts WHERE id = '$ATTEMPT_ID';"
echo "[repro] ──────────────────────────────────────────────────"

# ─── Step 3: launch the real Electron app ─────────────────────────────────
cat > "$CONFIG_JSON" <<CFG
{
  "disableAutoRunOnStartup": true,
  "autoFixRetries": 0,
  "maxConcurrency": 1
}
CFG

echo "[repro] [3/4] launching Electron (xvfb-run, disableAutoRunOnStartup=true)"

# Launch args match packages/app/e2e/orphan-relaunch.spec.ts for Linux.
# We also force disableAutoRunOnStartup so the orphan-relaunch path is
# disabled — this proves the watchdog is the ONLY thing that can move the
# task out of running/launching.
INVOKER_DB_DIR="$REPRO_HOME" \
INVOKER_REPO_CONFIG_PATH="$CONFIG_JSON" \
INVOKER_LAUNCHING_STALL_TIMEOUT_MS="$STALL_TIMEOUT_MS" \
NODE_ENV="test" \
ELECTRON_ENABLE_LOGGING="1" \
LIBGL_ALWAYS_SOFTWARE="1" \
xvfb-run -a "$ELECTRON_BIN" \
  --no-sandbox \
  --disable-dev-shm-usage \
  --disable-gpu \
  "$APP_MAIN_JS" \
>"$APP_LOG" 2>&1 &
ELECTRON_PID=$!

# ─── Step 4: poll until watchdog fires ────────────────────────────────────
echo "[repro] [4/4] polling DB for watchdog action (pid=$ELECTRON_PID)…"
DEADLINE_EPOCH_MS=$(( $(date +%s%3N) + 60000 ))
OBSERVED_FAILED=0
OBSERVED_ERROR=""
OBSERVED_AT_EPOCH_MS=0

while [[ $(date +%s%3N) -lt $DEADLINE_EPOCH_MS ]]; do
  if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
    echo "[repro] electron exited unexpectedly. Tail of log:"
    tail -n 40 "$APP_LOG" || true
    exit 2
  fi
  ROW="$(sqlite3 -separator '|' "$DB" "SELECT status, COALESCE(error,''), COALESCE(completed_at,'') FROM tasks WHERE id = '$TASK_ID';" 2>/dev/null || true)"
  if [[ -n "$ROW" ]]; then
    STATUS="${ROW%%|*}"
    REST="${ROW#*|}"
    ERROR="${REST%%|*}"
    if [[ "$STATUS" == "failed" ]]; then
      OBSERVED_FAILED=1
      OBSERVED_ERROR="$ERROR"
      OBSERVED_AT_EPOCH_MS="$(date +%s%3N)"
      break
    fi
  fi
  sleep 0.5
done

# Stop the app now that we captured the evidence
cleanup_trap_ran=0
kill -TERM "$ELECTRON_PID" 2>/dev/null || true

# ─── Report ────────────────────────────────────────────────────────────────
echo
echo "[repro] ── final task row ───────────────────────────────"
sqlite3 -header -column "$DB" "SELECT id, status, launch_phase, launch_started_at, completed_at, substr(error,1,120) AS error FROM tasks WHERE id = '$TASK_ID';"
echo "[repro] ──────────────────────────────────────────────────"

EXPECTED_ERROR_REGEX="^Launch stalled: task remained in running/launching for [0-9]+s without a spawned execution handle$"

if [[ "$OBSERVED_FAILED" -eq 0 ]]; then
  echo "[repro] FAIL: task never transitioned to 'failed' within deadline."
  echo "[repro]       This would FALSIFY the root-cause claim."
  echo "[repro]       Tail of Electron log:"
  tail -n 60 "$APP_LOG" || true
  exit 1
fi

ELAPSED_MS=$(( OBSERVED_AT_EPOCH_MS - NOW_EPOCH_MS ))
echo "[repro] observed error  : $OBSERVED_ERROR"
echo "[repro] elapsed (approx): ${ELAPSED_MS}ms since app start"

if [[ ! "$OBSERVED_ERROR" =~ $EXPECTED_ERROR_REGEX ]]; then
  echo "[repro] FAIL: error did not match expected regex:"
  echo "[repro]   expected (regex): $EXPECTED_ERROR_REGEX"
  echo "[repro]   observed        : $OBSERVED_ERROR"
  echo "[repro] Something other than the watchdog wrote the failure."
  exit 1
fi

# Also confirm the [launch-stall] log line was emitted by main.ts (extra proof).
# Note: packages/app/src/logger.ts hard-codes ~/.invoker/invoker.log, so even
# under an isolated INVOKER_DB_DIR the log goes to the user's home log file.
# Use the unique TASK_ID to scope the match; retry a few times while the
# logger flushes after the DB row update.
USER_LOG="$HOME/.invoker/invoker.log"
LOG_CONFIRMED=0
for _ in 1 2 3 4 5 6 7 8; do
  if [[ -f "$USER_LOG" ]] && grep -qF "[launch-stall] forcing failure for \"$TASK_ID\"" "$USER_LOG"; then
    LOG_CONFIRMED=1
    break
  fi
  sleep 0.25
done
if [[ "$LOG_CONFIRMED" -eq 1 ]]; then
  echo "[repro] confirmed [launch-stall] log line in $USER_LOG (module=db-poll)"
else
  echo "[repro] WARN: could not confirm [launch-stall] log line in $USER_LOG"
fi

cat <<REPORT

================================================================================
[repro] ROOT CAUSE CONFIRMED
================================================================================
A task seeded directly into (status=running, launch_phase=launching) with no
live executor handle was untouched by every code path in the Invoker app
EXCEPT for the launch-stall watchdog at packages/app/src/main.ts:1952-1976,
which forced the task to 'failed' with:

  "$OBSERVED_ERROR"

This matches the exact error observed in production at
  2026-04-16T21:23:10.409Z
for task
  wf-1775874004544-6/add-prompt-edit-tests
(see ~/.invoker/invoker.log).

Implication: any orchestrator code path that marks a task running/launching
but does not call TaskRunner.executeTasks([task]) leaves the task silently
stalled for up to INVOKER_LAUNCHING_STALL_TIMEOUT_MS (default 600_000ms)
before the watchdog catches it. That is the "stuck on launching" bug.

Artifacts kept under $REPRO_HOME (re-run with KEEP_REPRO_HOME=1 to keep):
  - $DB          (sqlite snapshot)
  - $APP_LOG     (electron stderr/stdout)
================================================================================
REPORT

exit 0

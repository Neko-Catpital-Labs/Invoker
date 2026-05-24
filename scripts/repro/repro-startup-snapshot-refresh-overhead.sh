#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot request.
#
# At app launch, the renderer seeds useTasks() state synchronously from the
# __INVOKER_BOOTSTRAP__ payload delivered through preload, and then fires a
# second, non-forced getTasks() that re-fetches the same data from main.
# On the captured perf trace that follow-up snapshot costs ~65-164ms IPC time
# and ~377KB of JSON after the graph is already painted to the user.
#
# This script reproduces that behaviour deterministically:
#   1. Seeds an isolated DB with several workflows + tasks via the headless CLI.
#   2. Launches the real Electron GUI against that DB with auto-run disabled
#      so the only owner-side work is the startup bootstrap + snapshot flow.
#   3. Waits for the ui-perf activity_log rows that mark bootstrap completion
#      and graph visibility.
#   4. Checks for a non-forced useTasks_snapshot_replace event with a larger
#      activity_log id than preload_bootstrap_sync (the redundant snapshot).
#
# Exit codes:
#   --expect-issue : 0 if the redundant snapshot is observed (current baseline),
#                    1 if it is absent (already fixed or fixture too small).
#   default        : 0 if the redundant snapshot is absent (post-optimization),
#                    1 if it is still present.
#   2              : setup / infrastructure failure.

set -euo pipefail

EXPECT_ISSUE=0
KEEP_TMP="${KEEP_TMP:-0}"
WORKFLOW_COUNT="${WORKFLOW_COUNT:-4}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-7}"
OBSERVE_SECONDS="${OBSERVE_SECONDS:-45}"

usage() {
  cat <<EOF
Usage: $0 [--expect-issue]

Environment overrides:
  WORKFLOW_COUNT       workflows to seed (default: 4)
  TASKS_PER_WORKFLOW   linear chain length per workflow (default: 7)
  OBSERVE_SECONDS      max time to wait for activity_log events (default: 45)
  KEEP_TMP=1           leave the isolated DB / log dir in place on exit
EOF
}

while (( $# > 0 )); do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
APP_MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
APP_PRELOAD_JS="$ROOT_DIR/packages/app/dist/preload.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"

if ! command -v sqlite3 >/dev/null 2>&1; then
  echo "repro: ERROR: sqlite3 CLI is required to inspect activity_log" >&2
  exit 2
fi
if ! command -v python3 >/dev/null 2>&1; then
  echo "repro: ERROR: python3 is required to analyze ui-perf events" >&2
  exit 2
fi

TMP_DIR="$(mktemp -d -t invoker-startup-snapshot.XXXXXX)"
HOME_DIR="$TMP_DIR/home"
DB_DIR="$HOME_DIR/.invoker"
REMOTE_REPO="$TMP_DIR/remote.git"
CONFIG_PATH="$TMP_DIR/config.json"
APP_LOG="$TMP_DIR/electron.log"
LOG_DB="$DB_DIR/invoker.db"

mkdir -p "$DB_DIR"

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
  if [[ "$KEEP_TMP" != "1" ]]; then
    rm -rf "$TMP_DIR"
  else
    echo "repro: KEEP_TMP=1, leaving $TMP_DIR in place" >&2
  fi
}
trap cleanup EXIT

cd "$ROOT_DIR"

if [[ ! -f "$APP_MAIN_JS" || ! -f "$APP_PRELOAD_JS" || ! -f "$HEADLESS_CLIENT_JS" ]]; then
  echo "repro: building @invoker/app (dist missing) ..." >&2
  pnpm --filter @invoker/app build >&2
fi

git init --bare "$REMOTE_REPO" >/dev/null 2>&1

cat > "$CONFIG_PATH" <<'EOF'
{
  "autoFixRetries": 0,
  "maxConcurrency": 1,
  "disableAutoRunOnStartup": true
}
EOF

export HOME="$HOME_DIR"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_HEADLESS_STANDALONE=1
export INVOKER_ALLOW_DELETE_ALL=1
export NODE_ENV=test

echo "repro: seeding $WORKFLOW_COUNT workflows ($TASKS_PER_WORKFLOW tasks each) into $DB_DIR ..."
for idx in $(seq 1 "$WORKFLOW_COUNT"); do
  plan_path="$TMP_DIR/plan-$idx.yaml"
  {
    echo "name: startup-snapshot-repro-$idx"
    echo "onFinish: none"
    echo "repoUrl: file://$REMOTE_REPO"
    echo "tasks:"
    prev=""
    for tidx in $(seq 1 "$TASKS_PER_WORKFLOW"); do
      echo "  - id: t$tidx"
      echo "    description: snapshot task $idx-$tidx"
      echo "    command: \"echo $idx-$tidx\""
      if [[ -n "$prev" ]]; then
        echo "    dependencies: [$prev]"
      fi
      prev="t$tidx"
    done
  } > "$plan_path"
  ./run.sh --headless --no-track run "$plan_path" \
    >"$TMP_DIR/seed-$idx.stdout" 2>"$TMP_DIR/seed-$idx.stderr"
done

# Hand DB ownership over to the GUI process.
unset INVOKER_HEADLESS_STANDALONE

ELECTRON_PREFIX=()
if [[ "$(uname)" == "Linux" ]]; then
  if [[ -z "${DISPLAY:-}" ]]; then
    if ! command -v xvfb-run >/dev/null 2>&1; then
      echo "repro: ERROR: this script requires xvfb-run on Linux when DISPLAY is unset" >&2
      exit 2
    fi
    ELECTRON_PREFIX=(xvfb-run -a)
  fi
  export LIBGL_ALWAYS_SOFTWARE=1
fi

echo "repro: launching Electron GUI against isolated DB ..."
INVOKER_STARTUP_POLL_DELAY_MS=0 \
ELECTRON_ENABLE_LOGGING=1 \
  "${ELECTRON_PREFIX[@]}" "$ELECTRON_BIN" \
    --no-sandbox \
    --disable-dev-shm-usage \
    --disable-gpu \
    --disable-gpu-compositing \
    --disable-software-rasterizer \
    "$APP_MAIN_JS" \
  >"$APP_LOG" 2>&1 &
ELECTRON_PID=$!

count_events() {
  local metric="$1"
  sqlite3 "$LOG_DB" \
    "SELECT COUNT(*) FROM activity_log WHERE source='ui-perf' AND message LIKE '%\"metric\":\"${metric}\"%';" \
    2>/dev/null || echo 0
}

DEADLINE=$(( $(date +%s) + OBSERVE_SECONDS ))
echo "repro: observing activity_log for up to ${OBSERVE_SECONDS}s (pid=$ELECTRON_PID) ..."

have_bootstrap=0
have_visible=0
while (( $(date +%s) < DEADLINE )); do
  if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
    echo "repro: ERROR: Electron exited prematurely. Tail of log:" >&2
    tail -n 80 "$APP_LOG" >&2 || true
    exit 2
  fi
  if [[ -f "$LOG_DB" ]]; then
    have_bootstrap="$(count_events preload_bootstrap_sync)"
    have_visible="$(count_events startup_workflow_graph_visible)"
    if [[ "$have_bootstrap" -gt 0 && "$have_visible" -gt 0 ]]; then
      # Give the renderer one more beat to flush any trailing
      # useTasks_snapshot_replace event before we stop.
      sleep 1
      break
    fi
  fi
  sleep 0.5
done

if [[ "$have_bootstrap" -le 0 || "$have_visible" -le 0 ]]; then
  echo "repro: ERROR: did not observe both preload_bootstrap_sync and startup_workflow_graph_visible within ${OBSERVE_SECONDS}s" >&2
  echo "  preload_bootstrap_sync rows: $have_bootstrap" >&2
  echo "  startup_workflow_graph_visible rows: $have_visible" >&2
  echo "Tail of electron.log:" >&2
  tail -n 80 "$APP_LOG" >&2 || true
  exit 2
fi

# Stop Electron before reading the DB; SQLite supports concurrent reads but
# we want a stable snapshot for the summary.
kill -TERM "$ELECTRON_PID" 2>/dev/null || true
for _ in 1 2 3 4 5; do
  sleep 0.3
  kill -0 "$ELECTRON_PID" 2>/dev/null || break
done
kill -KILL "$ELECTRON_PID" 2>/dev/null || true
ELECTRON_PID=""

python3 - "$LOG_DB" "$EXPECT_ISSUE" <<'PY'
import json
import sqlite3
import sys

db_path, expect_issue_str = sys.argv[1], sys.argv[2]
expect_issue = expect_issue_str == "1"

con = sqlite3.connect(db_path)
rows = con.execute(
    "SELECT id, message FROM activity_log WHERE source='ui-perf' ORDER BY id ASC"
).fetchall()

bootstrap = None
bootstrap_id = None
first_snapshot_replace = None
post_bootstrap_snapshot = None
graph_visible = None

for rowid, message in rows:
    try:
        payload = json.loads(message)
    except json.JSONDecodeError:
        continue
    metric = payload.get('metric')
    if metric == 'preload_bootstrap_sync' and bootstrap is None:
        bootstrap = payload
        bootstrap_id = rowid
        continue
    if metric == 'useTasks_snapshot_replace':
        if first_snapshot_replace is None:
            first_snapshot_replace = payload
        if (
            bootstrap_id is not None
            and rowid > bootstrap_id
            and post_bootstrap_snapshot is None
        ):
            post_bootstrap_snapshot = payload
        continue
    if metric == 'startup_workflow_graph_visible' and graph_visible is None:
        graph_visible = payload

chosen_snapshot = post_bootstrap_snapshot or first_snapshot_replace

def line(prefix, payload, key):
    if payload is None:
        return f"  {prefix}.{key}: <event missing>"
    return f"  {prefix}.{key}: {payload.get(key, '<missing>')}"

print("repro-summary:")
print(line("preload_bootstrap_sync", bootstrap, "taskCount"))
print(line("preload_bootstrap_sync", bootstrap, "workflowCount"))
print(line("preload_bootstrap_sync", bootstrap, "jsonSizeBytes"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "requestDurationMs"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "replaceDurationMs"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "forceRefresh"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "taskCount"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "workflowCount"))
print(line("useTasks_snapshot_replace", chosen_snapshot, "jsonSizeBytes"))
print(line("startup_workflow_graph_visible", graph_visible, "elapsedMs"))
print(line("startup_workflow_graph_visible", graph_visible, "processElapsedMs"))
print(line("startup_workflow_graph_visible", graph_visible, "nodeCount"))
print(line("startup_workflow_graph_visible", graph_visible, "edgeCount"))

redundant = bool(
    post_bootstrap_snapshot is not None
    and not post_bootstrap_snapshot.get('forceRefresh', False)
)
print(f"  redundant_post_bootstrap_non_forced_snapshot: {redundant}")
print(f"  expect_issue: {expect_issue}")

if expect_issue:
    sys.exit(0 if redundant else 1)
sys.exit(0 if not redundant else 1)
PY

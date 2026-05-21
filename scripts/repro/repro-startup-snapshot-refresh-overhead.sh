#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot request.
#
# Background
# ----------
# At GUI startup the preload script does a synchronous IPC
# (`invoker:get-bootstrap-state-sync`) that ships the full task + workflow
# graph to the renderer in one shot. This is reported as the
# `preload_bootstrap_sync` ui-perf event (with `taskCount`, `workflowCount`,
# `jsonSizeBytes`). The renderer mounts `useTasks` which seeds its in-memory
# Map from `window.__INVOKER_BOOTSTRAP__` — so the graph is already visible
# at first paint.
#
# Despite that, `useTasks.useEffect` calls `fetchAll()` (non-forced) on mount,
# which round-trips the same `getTasks()` snapshot over IPC and triggers
# `useTasks_snapshot_replace` (`forceRefresh=false`). On a non-trivial fixture
# this costs about 65–164ms of IPC + Map rebuild and moves ~377KB after the
# graph is already on screen.
#
# This script reproduces that redundant snapshot deterministically.
#
# What it does
# ------------
#   1. Provisions an isolated `INVOKER_DB_DIR` under a tmp dir.
#   2. Seeds the DB with N workflows × M tasks via `--headless --no-track run`
#      (no manual SQL — see `CLAUDE.md` SQLite Command Policy).
#   3. Launches the real Invoker Electron app against the isolated DB (under
#      `xvfb-run` on Linux when no DISPLAY is set).
#   4. Polls `activity_log` (source='ui-perf') until the startup graph-visible
#      event lands and the post-bootstrap snapshot has had a chance to fire.
#   5. Extracts the relevant ui-perf events and reports:
#        - bootstrap task/workflow counts and `jsonSizeBytes`
#        - `useTasks_snapshot_replace.requestDurationMs`
#        - `useTasks_snapshot_replace.replaceDurationMs`
#        - graph visible timing and node/edge counts
#        - whether the snapshot was forced
#
# Exit semantics
# --------------
#   With `--expect-issue` (baseline — bug still present):
#     exit 0  iff a non-forced `useTasks_snapshot_replace` was observed AFTER
#             `preload_bootstrap_sync` on this startup (the redundant snapshot).
#     exit 1  otherwise (the bug is gone or never reproduced).
#
#   Without `--expect-issue` (post-optimization — bug should be fixed):
#     exit 0  iff NO non-forced `useTasks_snapshot_replace` was observed AFTER
#             `preload_bootstrap_sync` on this startup.
#     exit 1  otherwise (the redundant snapshot is still firing).
#
#   exit 2  setup / infra failure (missing tool, build failure, electron
#           refused to start, no ui-perf events observed at all, etc.).
#
# Usage
# -----
#   bash scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#
# Env knobs (all optional):
#   WORKFLOWS=10          number of seeded workflows
#   TASKS_PER_WORKFLOW=8  tasks per seeded workflow
#   STARTUP_WAIT_SEC=45   max seconds to wait for graph-visible + post-bootstrap snapshot
#   KEEP_REPRO_HOME=1     keep the tmp directory (for inspection)

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,55p' "$0"
      exit 0
      ;;
    *)
      echo "[repro] unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOWS="${WORKFLOWS:-10}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-8}"
STARTUP_WAIT_SEC="${STARTUP_WAIT_SEC:-45}"

die() { echo "[repro] FATAL: $*" >&2; exit 2; }

command -v python3 >/dev/null || die "python3 is required (used for sqlite + json parsing)"
command -v pnpm    >/dev/null || die "pnpm is required to build dist artifacts"
command -v node    >/dev/null || die "node is required"

ELECTRON_BIN="$ROOT_DIR/scripts/electron.cjs"
APP_MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
HEADLESS_CLIENT_JS="$ROOT_DIR/packages/app/dist/headless-client.js"

[[ -x "$ELECTRON_BIN" ]] || die "missing electron launcher at $ELECTRON_BIN"

# Build only what we need if dist is missing — keep this fast on warm trees.
if [[ ! -f "$APP_MAIN_JS" || ! -f "$HEADLESS_CLIENT_JS" ]]; then
  echo "[repro] building @invoker/app (dist artifacts missing)..."
  ( cd "$ROOT_DIR" && pnpm --filter @invoker/app build >&2 )
fi
[[ -f "$APP_MAIN_JS"      ]] || die "missing $APP_MAIN_JS after build"
[[ -f "$HEADLESS_CLIENT_JS" ]] || die "missing $HEADLESS_CLIENT_JS after build"

STAMP="$(date +%s)-$$"
REPRO_HOME="${TMPDIR:-/tmp}/invoker-repros/startup-snapshot-refresh-$STAMP"
DB_DIR="$REPRO_HOME/home/.invoker"
DB_PATH="$DB_DIR/invoker.db"
CONFIG_PATH="$REPRO_HOME/config.json"
APP_LOG="$REPRO_HOME/electron.log"
SEED_LOG_DIR="$REPRO_HOME/seed-logs"
mkdir -p "$DB_DIR" "$SEED_LOG_DIR"

ELECTRON_PID=""
cleanup() {
  if [[ -n "$ELECTRON_PID" ]] && kill -0 "$ELECTRON_PID" 2>/dev/null; then
    kill -TERM "$ELECTRON_PID" 2>/dev/null || true
    for _ in 1 2 3 4 5 6 7 8 9 10; do
      sleep 0.2
      kill -0 "$ELECTRON_PID" 2>/dev/null || break
    done
    kill -KILL "$ELECTRON_PID" 2>/dev/null || true
  fi
  if [[ "${KEEP_REPRO_HOME:-0}" != "1" ]]; then
    rm -rf "$REPRO_HOME" 2>/dev/null || true
  else
    echo "[repro] KEEP_REPRO_HOME=1 — leaving artifacts under $REPRO_HOME" >&2
  fi
}
trap cleanup EXIT

echo "[repro] repro root        : $REPRO_HOME"
echo "[repro] db path           : $DB_PATH"
echo "[repro] fixture           : $WORKFLOWS workflows × $TASKS_PER_WORKFLOW tasks"
echo "[repro] expect-issue      : $EXPECT_ISSUE"

cat > "$CONFIG_PATH" <<EOF
{"autoFixRetries":0,"maxConcurrency":1,"disableAutoRunOnStartup":true}
EOF

export HOME="$REPRO_HOME/home"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_HEADLESS_STANDALONE=1
export NODE_ENV=test

# ── Step 1: seed N workflows × M tasks via headless --no-track run ──────────
echo "[repro] [1/4] seeding $WORKFLOWS workflows…"
for idx in $(seq 1 "$WORKFLOWS"); do
  plan_path="$REPRO_HOME/plan-$idx.yaml"
  {
    printf 'name: "startup-snapshot-fixture-%d"\n' "$idx"
    printf 'onFinish: none\n'
    printf 'mergeMode: manual\n'
    printf 'repoUrl: "file://%s"\n' "$REPRO_HOME"
    printf 'baseBranch: HEAD\n'
    printf 'tasks:\n'
    for j in $(seq 1 "$TASKS_PER_WORKFLOW"); do
      printf '  - id: task-%d-%d\n' "$idx" "$j"
      printf '    description: "fixture task %d/%d"\n' "$idx" "$j"
      printf '    command: "echo fixture-%d-%d"\n' "$idx" "$j"
      if [[ "$j" -gt 1 ]]; then
        printf '    dependencies: [task-%d-%d]\n' "$idx" "$((j-1))"
      else
        printf '    dependencies: []\n'
      fi
    done
  } > "$plan_path"

  if ! ( cd "$ROOT_DIR" && ./run.sh --headless --no-track run "$plan_path" ) \
        > "$SEED_LOG_DIR/seed-$idx.stdout.log" 2> "$SEED_LOG_DIR/seed-$idx.stderr.log"; then
    echo "[repro] seeding workflow $idx failed:" >&2
    tail -n 40 "$SEED_LOG_DIR/seed-$idx.stderr.log" >&2 || true
    exit 2
  fi
done

SEEDED_TASKS="$(python3 - "$DB_PATH" <<'PY'
import sqlite3, sys
db = sys.argv[1]
con = sqlite3.connect(db)
n = con.execute("SELECT COUNT(*) FROM tasks").fetchone()[0]
w = con.execute("SELECT COUNT(*) FROM workflows").fetchone()[0]
print(f"{n} {w}")
PY
)"
SEEDED_TASK_COUNT="${SEEDED_TASKS%% *}"
SEEDED_WORKFLOW_COUNT="${SEEDED_TASKS##* }"
echo "[repro]         seeded $SEEDED_WORKFLOW_COUNT workflows / $SEEDED_TASK_COUNT tasks into $DB_PATH"

if [[ "${SEEDED_WORKFLOW_COUNT:-0}" -lt 1 || "${SEEDED_TASK_COUNT:-0}" -lt 1 ]]; then
  die "expected the fixture DB to contain seeded workflows/tasks; nothing landed"
fi

# Capture the activity_log high-water mark BEFORE launching Electron so we
# scope the analysis to events emitted by this GUI startup only.
PRE_LAUNCH_MAX_ID="$(python3 - "$DB_PATH" <<'PY'
import sqlite3, sys
con = sqlite3.connect(sys.argv[1])
row = con.execute("SELECT COALESCE(MAX(id),0) FROM activity_log").fetchone()
print(row[0] if row else 0)
PY
)"
echo "[repro]         activity_log baseline id = $PRE_LAUNCH_MAX_ID"

# ── Step 2: launch the real Invoker GUI (Electron) ──────────────────────────
echo "[repro] [2/4] launching Electron GUI…"

LAUNCHER=("$ELECTRON_BIN")
LAUNCH_ARGS=("--no-sandbox" "--disable-dev-shm-usage" "--disable-gpu" "$APP_MAIN_JS")
case "$(uname)" in
  Linux)
    export LIBGL_ALWAYS_SOFTWARE=1
    if [[ -z "${DISPLAY:-}" ]]; then
      command -v xvfb-run >/dev/null \
        || die "xvfb-run not found and DISPLAY is unset (needed to run Electron on headless Linux)"
      LAUNCHER=(xvfb-run -a "$ELECTRON_BIN")
    fi
    ;;
  Darwin) ;;
  *) die "unsupported platform: $(uname)" ;;
esac

ELECTRON_ENABLE_LOGGING=1 "${LAUNCHER[@]}" "${LAUNCH_ARGS[@]}" \
  >"$APP_LOG" 2>&1 &
ELECTRON_PID=$!
echo "[repro]         electron pid = $ELECTRON_PID"

# ── Step 3: poll activity_log until graph-visible + post-bootstrap snapshot ─
echo "[repro] [3/4] waiting up to ${STARTUP_WAIT_SEC}s for startup ui-perf events…"

POLL_STARTED_AT="$(date +%s)"
SETTLE_MS="${SETTLE_MS:-2000}"   # extra wait after graph-visible for any post-bootstrap snapshot to land
SAW_BOOTSTRAP=0
SAW_GRAPH_VISIBLE=0
SETTLED_AT=""

while true; do
  if ! kill -0 "$ELECTRON_PID" 2>/dev/null; then
    echo "[repro] electron exited prematurely. Tail of log:" >&2
    tail -n 60 "$APP_LOG" >&2 || true
    exit 2
  fi

  now_s="$(date +%s)"
  if (( now_s - POLL_STARTED_AT > STARTUP_WAIT_SEC )); then
    echo "[repro] WARN: timed out waiting for startup ui-perf events after ${STARTUP_WAIT_SEC}s" >&2
    break
  fi

  read -r SAW_BOOTSTRAP SAW_GRAPH_VISIBLE <<<"$(python3 - "$DB_PATH" "$PRE_LAUNCH_MAX_ID" <<'PY'
import json, sqlite3, sys
con = sqlite3.connect(sys.argv[1])
since = int(sys.argv[2])
rows = con.execute(
    "SELECT message FROM activity_log WHERE id > ? AND source = 'ui-perf' ORDER BY id ASC",
    (since,),
).fetchall()
seen_bootstrap = 0
seen_graph = 0
for (msg,) in rows:
    try:
        payload = json.loads(msg)
    except Exception:
        continue
    metric = payload.get("metric")
    if metric == "preload_bootstrap_sync":
        seen_bootstrap = 1
    elif metric in ("startup_workflow_graph_visible", "startup_graph_visible"):
        seen_graph = 1
print(f"{seen_bootstrap} {seen_graph}")
PY
)"

  if [[ "$SAW_GRAPH_VISIBLE" = "1" && -z "$SETTLED_AT" ]]; then
    SETTLED_AT="$(date +%s%3N)"
  fi
  if [[ -n "$SETTLED_AT" ]]; then
    now_ms="$(date +%s%3N)"
    if (( now_ms - SETTLED_AT >= SETTLE_MS )); then
      break
    fi
  fi
  sleep 0.5
done

# ── Step 4: stop Electron and analyze the captured ui-perf events ──────────
echo "[repro] [4/4] stopping Electron and analyzing ui-perf events…"
if kill -0 "$ELECTRON_PID" 2>/dev/null; then
  kill -TERM "$ELECTRON_PID" 2>/dev/null || true
fi

ANALYSIS_PATH="$REPRO_HOME/analysis.json"
python3 - "$DB_PATH" "$PRE_LAUNCH_MAX_ID" "$ANALYSIS_PATH" <<'PY'
import json, sqlite3, sys

db, since, out_path = sys.argv[1], int(sys.argv[2]), sys.argv[3]
con = sqlite3.connect(db)
rows = con.execute(
    "SELECT id, timestamp, message FROM activity_log "
    "WHERE id > ? AND source = 'ui-perf' ORDER BY id ASC",
    (since,),
).fetchall()

events = []
for (rid, ts, msg) in rows:
    try:
        payload = json.loads(msg)
    except Exception:
        continue
    payload["_id"] = rid
    payload["_timestamp"] = ts
    events.append(payload)

def first(metric):
    for ev in events:
        if ev.get("metric") == metric:
            return ev
    return None

def first_after(metric, after_id, **predicates):
    for ev in events:
        if ev.get("_id") <= after_id:
            continue
        if ev.get("metric") != metric:
            continue
        if any(ev.get(k) != v for k, v in predicates.items()):
            continue
        return ev
    return None

bootstrap = first("preload_bootstrap_sync")
wf_graph  = first("startup_workflow_graph_visible")
tk_graph  = first("startup_graph_visible")

# The "redundant" snapshot is the first non-forced useTasks_snapshot_replace
# AFTER the preload_bootstrap_sync event.
redundant = None
first_snapshot = None
if bootstrap is not None:
    first_snapshot = first_after("useTasks_snapshot_replace", bootstrap["_id"])
    redundant = first_after(
        "useTasks_snapshot_replace", bootstrap["_id"], forceRefresh=False
    )

analysis = {
    "preload_bootstrap_sync": bootstrap,
    "first_post_bootstrap_useTasks_snapshot_replace": first_snapshot,
    "first_post_bootstrap_non_forced_useTasks_snapshot_replace": redundant,
    "startup_workflow_graph_visible": wf_graph,
    "startup_graph_visible": tk_graph,
    "all_ui_perf_metrics_in_order": [ev.get("metric") for ev in events],
}
with open(out_path, "w", encoding="utf-8") as fh:
    json.dump(analysis, fh, indent=2, sort_keys=True, default=str)

# Print the human-readable report on stdout.
def fmt(v):
    return "—" if v is None else v

def get(ev, key):
    return None if ev is None else ev.get(key)

print()
print("==== Startup snapshot ui-perf summary ====")
print(f"bootstrap.taskCount         : {fmt(get(bootstrap, 'taskCount'))}")
print(f"bootstrap.workflowCount     : {fmt(get(bootstrap, 'workflowCount'))}")
print(f"bootstrap.jsonSizeBytes     : {fmt(get(bootstrap, 'jsonSizeBytes'))}")
print(f"bootstrap.durationMs        : {fmt(get(bootstrap, 'durationMs'))}")
print(f"snapshot.forceRefresh       : {fmt(get(first_snapshot, 'forceRefresh'))}")
print(f"snapshot.requestDurationMs  : {fmt(get(first_snapshot, 'requestDurationMs'))}")
print(f"snapshot.replaceDurationMs  : {fmt(get(first_snapshot, 'replaceDurationMs'))}")
print(f"snapshot.taskCount          : {fmt(get(first_snapshot, 'taskCount'))}")
print(f"snapshot.jsonSizeBytes      : {fmt(get(first_snapshot, 'jsonSizeBytes'))}")
print(f"workflow-graph nodeCount    : {fmt(get(wf_graph, 'nodeCount'))}")
print(f"workflow-graph edgeCount    : {fmt(get(wf_graph, 'edgeCount'))}")
print(f"workflow-graph elapsedMs    : {fmt(get(wf_graph, 'elapsedMs'))}")
print(f"workflow-graph procElapsedMs: {fmt(get(wf_graph, 'processElapsedMs'))}")
print(f"task-graph nodeCount        : {fmt(get(tk_graph, 'nodeCount'))}")
print(f"task-graph elapsedMs        : {fmt(get(tk_graph, 'elapsedMs'))}")
print(f"redundant_non_forced_snapshot_observed: "
      f"{'yes' if redundant is not None else 'no'}")
print("ui-perf metric order        :", ", ".join(
    m for m in (ev.get("metric") for ev in events) if m
))
print()

# Sentinel line consumed by the wrapping bash script for the exit decision.
print(f"REPRO_REDUNDANT_OBSERVED={'1' if redundant is not None else '0'}")
print(f"REPRO_BOOTSTRAP_OBSERVED={'1' if bootstrap is not None else '0'}")
print(f"REPRO_GRAPH_VISIBLE_OBSERVED={'1' if wf_graph is not None or tk_graph is not None else '0'}")
PY
ANALYSIS_RC=$?
if [[ "$ANALYSIS_RC" != "0" ]]; then
  echo "[repro] analysis script failed (rc=$ANALYSIS_RC)" >&2
  exit 2
fi

# Re-read the sentinel lines from analysis.json so we make the exit decision
# in bash without re-parsing the human-readable output.
REDUNDANT_OBSERVED="$(python3 - "$ANALYSIS_PATH" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(1 if data.get("first_post_bootstrap_non_forced_useTasks_snapshot_replace") else 0)
PY
)"
BOOTSTRAP_OBSERVED="$(python3 - "$ANALYSIS_PATH" <<'PY'
import json, sys
data = json.load(open(sys.argv[1]))
print(1 if data.get("preload_bootstrap_sync") else 0)
PY
)"

if [[ "$BOOTSTRAP_OBSERVED" != "1" ]]; then
  echo "[repro] FATAL: never observed preload_bootstrap_sync — Electron likely did not finish bootstrapping." >&2
  echo "[repro] Tail of electron log:" >&2
  tail -n 80 "$APP_LOG" >&2 || true
  exit 2
fi

if [[ "$EXPECT_ISSUE" = "1" ]]; then
  if [[ "$REDUNDANT_OBSERVED" = "1" ]]; then
    echo "[repro] PASS (--expect-issue): observed redundant non-forced useTasks_snapshot_replace after preload_bootstrap_sync."
    exit 0
  fi
  echo "[repro] FAIL (--expect-issue): did NOT observe a redundant non-forced startup snapshot." >&2
  echo "[repro] Either the bug is already fixed on this branch or the fixture did not exercise the path." >&2
  exit 1
fi

if [[ "$REDUNDANT_OBSERVED" = "1" ]]; then
  echo "[repro] FAIL: a redundant non-forced useTasks_snapshot_replace fired after preload_bootstrap_sync — optimization regressed." >&2
  exit 1
fi
echo "[repro] PASS: no redundant non-forced useTasks_snapshot_replace fired after preload_bootstrap_sync."
exit 0

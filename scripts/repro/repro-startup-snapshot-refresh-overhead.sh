#!/usr/bin/env bash
# Repro for the redundant post-bootstrap startup snapshot refresh.
#
# After preload.ts emits `preload_bootstrap_sync`, useTasks.ts unconditionally
# calls `getTasks(false)` on mount and applies a `useTasks_snapshot_replace`
# even though `window.__INVOKER_BOOTSTRAP__` already populated the same data.
# Production traces show that second snapshot costs ~65-164ms per launch and
# moves ~377KB after the React Flow graph is already visible.
#
# This script drives an isolated Electron startup against a seeded
# multi-workflow DB and inspects the activity_log to confirm (or deny) the
# redundant non-forced snapshot:
#
#   1. Build @invoker/app if `packages/app/dist/main.js` is missing.
#   2. Create an isolated INVOKER_DB_DIR + bare repo + claude stub.
#   3. Seed N workflows (M tasks each) by launching Electron once and calling
#      `window.invoker.loadPlan(...)` via Playwright `_electron`.
#   4. Cold-launch Electron a second time with `disableAutoRunOnStartup=true`
#      so no task dispatcher fires, wait for the React Flow graph to render,
#      then dump `activity_log` rows captured after the relaunch start.
#   5. Parse rows tagged source=ui-perf, extract the metrics required to
#      reason about the regression, print a summary, and exit based on
#      `--expect-issue`:
#        * `--expect-issue` set: exit 0 when a non-forced
#          `useTasks_snapshot_replace` lands AFTER `preload_bootstrap_sync`
#          (baseline reproduced); exit 1 otherwise.
#        * default              : exit 0 when there is NO redundant non-forced
#          snapshot after bootstrap (i.e. the fix is in); exit 1 otherwise.
#
# Env knobs (also exposed via CLI flags):
#   SEED_WORKFLOW_COUNT       Workflows to seed (default 6)
#   SEED_TASKS_PER_WORKFLOW   Tasks per workflow (default 8)
#   LAUNCH_TIMEOUT_MS         Wait budget per Electron launch (default 45000)
#   KEEP_TMP=1                Keep the temp INVOKER_DB_DIR for inspection
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

EXPECT_ISSUE=0
SEED_WORKFLOW_COUNT="${SEED_WORKFLOW_COUNT:-6}"
SEED_TASKS_PER_WORKFLOW="${SEED_TASKS_PER_WORKFLOW:-8}"
LAUNCH_TIMEOUT_MS="${LAUNCH_TIMEOUT_MS:-45000}"

usage() {
  sed -n '2,/^set -euo pipefail$/p' "$0" | sed -e 's/^# \{0,1\}//' -e '$d'
  exit "${1:-0}"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) SEED_WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) SEED_TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --launch-timeout-ms) LAUNCH_TIMEOUT_MS="$2"; shift 2 ;;
    -h|--help) usage 0 ;;
    *) echo "[repro] unknown arg: $1" >&2; usage 1 ;;
  esac
done

if (( SEED_WORKFLOW_COUNT < 2 )); then
  echo "[repro] SEED_WORKFLOW_COUNT must be >= 2 to exercise multi-workflow bootstrap" >&2
  exit 64
fi

TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-repro.XXXXXX)"
DB_DIR="$TMP_DIR/db"
BARE_REPO="$TMP_DIR/bare.git"
STUB_DIR="$TMP_DIR/claude-stub"
MARKER_ROOT="$TMP_DIR/markers"
CONFIG_PATH="$TMP_DIR/config.json"
DRIVER_JS="$TMP_DIR/driver.cjs"
SEED_LOG="$TMP_DIR/seed.log"
MEASURE_LOG="$TMP_DIR/measure.log"
MEASURE_JSON="$TMP_DIR/measure.json"

cleanup() {
  if [[ "${KEEP_TMP:-0}" == "1" ]]; then
    echo "[repro] KEEP_TMP=1; artifacts kept under $TMP_DIR" >&2
    return
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$STUB_DIR" "$MARKER_ROOT"
git init --bare --quiet "$BARE_REPO"

# Stub `claude` on PATH so the orchestrator never tries to call the real CLI
# even if a stray dispatcher fires. We pin disableAutoRunOnStartup=true in the
# measurement phase, but the stub is cheap insurance.
CLAUDE_MARKER="$ROOT_DIR/scripts/e2e-dry-run/fixtures/claude-marker.sh"
if [[ ! -x "$CLAUDE_MARKER" ]]; then
  echo "[repro] missing claude marker at $CLAUDE_MARKER" >&2
  exit 2
fi
ln -sf "$CLAUDE_MARKER" "$STUB_DIR/claude"

cat >"$CONFIG_PATH" <<JSON
{
  "autoFixRetries": 0,
  "maxConcurrency": 1,
  "disableAutoRunOnStartup": true
}
JSON

# Build the Electron app if dist artifacts are missing. The repro requires
# packages/app/dist/main.js + the renderer bundle.
if [[ ! -f "$ROOT_DIR/packages/app/dist/main.js" ]]; then
  echo "[repro] building @invoker/app (dist missing)..." >&2
  (cd "$ROOT_DIR" \
    && pnpm --filter @invoker/ui build >&2 \
    && pnpm --filter @invoker/app build >&2)
fi

cat >"$DRIVER_JS" <<'NODE'
// Self-contained Playwright Electron driver for the startup-snapshot repro.
// Modes:
//   seed     — launch Electron once, loadPlan() N workflows, close.
//   measure  — launch a second time, wait for graph visible + bootstrap +
//              snapshot_replace activity events, then dump rows newer than
//              REPRO_MEASURE_START_ISO as { events: [...] } JSON on stdout.
const path = require('node:path');
const fs = require('node:fs');

function requireFromApp(modName) {
  const appPkg = path.join(process.env.REPRO_ROOT_DIR, 'packages', 'app', 'package.json');
  return require(require.resolve(modName, { paths: [path.dirname(appPkg)] }));
}

const { _electron: electron } = requireFromApp('@playwright/test');
const yaml = requireFromApp('yaml');

const mode = process.argv[2];
if (mode !== 'seed' && mode !== 'measure') {
  process.stderr.write(`[driver] mode must be 'seed' or 'measure'\n`);
  process.exit(2);
}

const ROOT_DIR = process.env.REPRO_ROOT_DIR;
const DB_DIR = process.env.REPRO_DB_DIR;
const REPO_URL = process.env.REPRO_REPO_URL;
const STUB_DIR = process.env.REPRO_STUB_DIR;
const MARKER_ROOT = process.env.REPRO_MARKER_ROOT;
const CONFIG_PATH = process.env.REPRO_CONFIG_PATH;
const WORKFLOW_COUNT = parseInt(process.env.SEED_WORKFLOW_COUNT, 10);
const TASKS_PER_WORKFLOW = parseInt(process.env.SEED_TASKS_PER_WORKFLOW, 10);
const LAUNCH_TIMEOUT_MS = parseInt(process.env.LAUNCH_TIMEOUT_MS, 10);
const MEASURE_START_ISO = process.env.REPRO_MEASURE_START_ISO || null;

const MAIN_JS = path.join(ROOT_DIR, 'packages', 'app', 'dist', 'main.js');

const platformArgs = process.platform === 'linux'
  ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
     '--disable-gpu-compositing', '--disable-gpu-sandbox',
     '--disable-software-rasterizer']
  : [];

function launchEnv(extra) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
    INVOKER_E2E_MARKER_ROOT: MARKER_ROOT,
    INVOKER_CLAUDE_COMMAND: path.join(STUB_DIR, 'claude'),
    INVOKER_CLAUDE_FIX_COMMAND: path.join(STUB_DIR, 'claude'),
    PATH: `${STUB_DIR}${path.delimiter}${process.env.PATH || ''}`,
    ...(extra || {}),
  };
}

function buildPlan(index) {
  return {
    name: `startup-snapshot-repro-${index}`,
    repoUrl: REPO_URL,
    onFinish: 'none',
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Repro task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function launch(extraEnv) {
  return electron.launch({
    args: [...platformArgs, MAIN_JS],
    env: launchEnv(extraEnv),
    timeout: LAUNCH_TIMEOUT_MS,
  });
}

async function waitForRendererReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: LAUNCH_TIMEOUT_MS });
  await page.waitForFunction(
    () => typeof window.invoker !== 'undefined' && typeof window.invoker.loadPlan === 'function',
    null,
    { timeout: LAUNCH_TIMEOUT_MS },
  );
}

async function seed() {
  const app = await launch({
    // Block any auto-dispatch even if the seeded plan is loaded mid-startup.
    INVOKER_TEST_RESUME_PENDING_DELAY_MS: '600000',
  });
  try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await waitForRendererReady(page);
    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      const planYaml = yaml.stringify(buildPlan(i));
      await page.evaluate(async (text) => {
        await window.invoker.loadPlan(text);
      }, planYaml);
    }
    const expectedTaskCount = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    await page.waitForFunction(
      async (expected) => {
        const result = await window.invoker.getTasks(true);
        const tasks = Array.isArray(result) ? result : (result.tasks || []);
        return tasks.length >= expected;
      },
      expectedTaskCount,
      { timeout: LAUNCH_TIMEOUT_MS, polling: 250 },
    );
  } finally {
    await app.close().catch(() => undefined);
  }
}

async function measure() {
  if (!MEASURE_START_ISO) {
    throw new Error('REPRO_MEASURE_START_ISO must be set for measure mode');
  }
  const app = await launch({
    // Hold back the orphan-resume path so the renderer's startup snapshot
    // path is what we observe (not a re-dispatched task firing tasks_replace).
    INVOKER_TEST_RESUME_PENDING_DELAY_MS: '600000',
  });
  try {
    const page = await app.firstWindow({ timeout: LAUNCH_TIMEOUT_MS });
    await waitForRendererReady(page);

    // Wait for the React Flow workflow graph to be visible AND for the
    // snapshot_replace + bootstrap_sync events to land in activity_log.
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
      state: 'visible',
      timeout: LAUNCH_TIMEOUT_MS,
    });
    await page.waitForFunction(
      async (sinceIso) => {
        const logs = await window.invoker.getActivityLogs();
        let sawBootstrap = false;
        let sawSnapshot = false;
        let sawWfGraphVisible = false;
        for (const entry of logs) {
          if (entry.source !== 'ui-perf') continue;
          if (sinceIso && entry.timestamp && entry.timestamp < sinceIso) continue;
          let payload;
          try { payload = JSON.parse(entry.message); } catch { continue; }
          if (!payload || typeof payload.metric !== 'string') continue;
          if (sinceIso && payload.ts && payload.ts < sinceIso) continue;
          if (payload.metric === 'preload_bootstrap_sync') sawBootstrap = true;
          if (payload.metric === 'useTasks_snapshot_replace') sawSnapshot = true;
          if (payload.metric === 'startup_workflow_graph_visible') sawWfGraphVisible = true;
        }
        return sawBootstrap && sawWfGraphVisible && sawSnapshot;
      },
      MEASURE_START_ISO,
      { timeout: LAUNCH_TIMEOUT_MS, polling: 200 },
    ).catch(() => undefined);

    // Snapshot every activity_log row (we'll filter in bash).
    const events = await page.evaluate(async () => {
      const logs = await window.invoker.getActivityLogs();
      return logs.map((entry) => ({
        id: entry.id,
        timestamp: entry.timestamp,
        source: entry.source,
        level: entry.level,
        message: entry.message,
      }));
    });
    process.stdout.write(JSON.stringify({ measureStartIso: MEASURE_START_ISO, events }) + '\n');
  } finally {
    await app.close().catch(() => undefined);
  }
}

(async () => {
  try {
    if (mode === 'seed') await seed();
    else await measure();
  } catch (err) {
    const stack = err && err.stack ? err.stack : String(err);
    process.stderr.write(`[driver:${mode}] error: ${stack}\n`);
    process.exit(3);
  }
})();
NODE

export REPRO_ROOT_DIR="$ROOT_DIR"
export REPRO_DB_DIR="$DB_DIR"
export REPRO_REPO_URL="file://$BARE_REPO"
export REPRO_STUB_DIR="$STUB_DIR"
export REPRO_MARKER_ROOT="$MARKER_ROOT"
export REPRO_CONFIG_PATH="$CONFIG_PATH"
export SEED_WORKFLOW_COUNT
export SEED_TASKS_PER_WORKFLOW
export LAUNCH_TIMEOUT_MS

NEED_XVFB=0
if [[ "$(uname)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "[repro] Linux without DISPLAY requires xvfb-run; install xvfb or set DISPLAY." >&2
    exit 2
  fi
  NEED_XVFB=1
fi

run_driver() {
  local mode="$1"
  local out_log="$2"
  shift 2
  if (( NEED_XVFB == 1 )); then
    xvfb-run --auto-servernum node "$DRIVER_JS" "$mode" "$@" 2>"$out_log"
  else
    node "$DRIVER_JS" "$mode" "$@" 2>"$out_log"
  fi
}

echo "[repro] seeding $SEED_WORKFLOW_COUNT workflows x $SEED_TASKS_PER_WORKFLOW tasks into $DB_DIR" >&2
if ! run_driver seed "$SEED_LOG" >/dev/null; then
  echo "[repro] seed phase failed; driver stderr:" >&2
  tail -n 80 "$SEED_LOG" >&2 || true
  exit 2
fi

MEASURE_START_ISO="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ 2>/dev/null \
  || python3 -c 'import datetime; print(datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%S.")+f"{datetime.datetime.utcnow().microsecond//1000:03d}Z")')"
export REPRO_MEASURE_START_ISO="$MEASURE_START_ISO"

echo "[repro] measuring relaunch starting at $MEASURE_START_ISO" >&2
if ! run_driver measure "$MEASURE_LOG" >"$MEASURE_JSON"; then
  echo "[repro] measure phase failed; driver stderr:" >&2
  tail -n 80 "$MEASURE_LOG" >&2 || true
  exit 2
fi

if [[ ! -s "$MEASURE_JSON" ]]; then
  echo "[repro] measure phase produced no JSON output; driver stderr:" >&2
  tail -n 80 "$MEASURE_LOG" >&2 || true
  exit 2
fi

# Analyse, print summary, and pick an exit code from EXPECT_ISSUE.
EXPECT_ISSUE="$EXPECT_ISSUE" MEASURE_START_ISO="$MEASURE_START_ISO" \
python3 - "$MEASURE_JSON" <<'PY'
import json
import os
import sys

measure_json_path = sys.argv[1]
expect_issue = os.environ.get("EXPECT_ISSUE", "0") == "1"
since_iso = os.environ.get("MEASURE_START_ISO") or ""

with open(measure_json_path, "r", encoding="utf-8") as fh:
    payload = json.load(fh)

events = payload.get("events", [])

def after_start(entry, parsed):
    # Prefer the payload ts (set by main process at write time); fall back to
    # the row timestamp (datetime('now') default; no millisecond resolution).
    ts = parsed.get("ts") if isinstance(parsed, dict) else None
    if isinstance(ts, str) and ts >= since_iso:
        return True
    if ts is None:
        row_ts = entry.get("timestamp") or ""
        return row_ts >= since_iso[:19]  # row timestamps are 'YYYY-MM-DD HH:MM:SS'
    return False

ui_events = []
for entry in events:
    if entry.get("source") != "ui-perf":
        continue
    try:
        parsed = json.loads(entry.get("message", "") or "")
    except Exception:
        continue
    if not isinstance(parsed, dict):
        continue
    if since_iso and not after_start(entry, parsed):
        continue
    parsed["_row_id"] = entry.get("id")
    parsed["_row_ts"] = entry.get("timestamp")
    ui_events.append(parsed)

ui_events.sort(key=lambda p: (p.get("ts") or "", p.get("_row_id") or 0))

def first(metric):
    for ev in ui_events:
        if ev.get("metric") == metric:
            return ev
    return None

bootstrap = first("preload_bootstrap_sync")
snapshot_events = [ev for ev in ui_events if ev.get("metric") == "useTasks_snapshot_replace"]
wf_graph = first("startup_workflow_graph_visible")
task_graph = first("startup_graph_visible")
startup_applied = first("startup_snapshot_applied")
startup_skipped = first("startup_snapshot_skipped_smaller_than_bootstrap")

def bootstrap_index():
    if bootstrap is None:
        return None
    for idx, ev in enumerate(ui_events):
        if ev is bootstrap:
            return idx
    return None

bs_idx = bootstrap_index()
post_bootstrap_non_forced = []
if bs_idx is not None:
    for ev in ui_events[bs_idx + 1:]:
        if ev.get("metric") != "useTasks_snapshot_replace":
            continue
        if ev.get("forceRefresh") is True:
            continue
        post_bootstrap_non_forced.append(ev)

snapshot_for_summary = post_bootstrap_non_forced[0] if post_bootstrap_non_forced \
    else (snapshot_events[0] if snapshot_events else None)

def fmt_num(value):
    if value is None:
        return "n/a"
    if isinstance(value, float):
        return f"{value:.2f}"
    return str(value)

print("[repro] --- startup snapshot summary ---")
print(f"[repro] measure window start         : {since_iso or '(unset)'}")
print(f"[repro] ui-perf events captured      : {len(ui_events)}")

if bootstrap is None:
    print("[repro] preload_bootstrap_sync       : MISSING")
else:
    print(f"[repro] bootstrap.taskCount          : {fmt_num(bootstrap.get('taskCount'))}")
    print(f"[repro] bootstrap.workflowCount      : {fmt_num(bootstrap.get('workflowCount'))}")
    print(f"[repro] bootstrap.jsonSizeBytes      : {fmt_num(bootstrap.get('jsonSizeBytes'))}")
    print(f"[repro] bootstrap.durationMs         : {fmt_num(bootstrap.get('durationMs'))}")

if snapshot_for_summary is None:
    print("[repro] useTasks_snapshot_replace    : NONE")
else:
    print(f"[repro] snapshot.forceRefresh        : {snapshot_for_summary.get('forceRefresh')}")
    print(f"[repro] snapshot.requestDurationMs   : {fmt_num(snapshot_for_summary.get('requestDurationMs'))}")
    print(f"[repro] snapshot.replaceDurationMs   : {fmt_num(snapshot_for_summary.get('replaceDurationMs'))}")
    print(f"[repro] snapshot.jsonSizeBytes       : {fmt_num(snapshot_for_summary.get('jsonSizeBytes'))}")
    print(f"[repro] snapshot.taskCount           : {fmt_num(snapshot_for_summary.get('taskCount'))}")
    print(f"[repro] snapshot.workflowCount       : {fmt_num(snapshot_for_summary.get('workflowCount'))}")

if wf_graph is None:
    print("[repro] startup_workflow_graph_visible: MISSING")
else:
    print(f"[repro] wfGraph.nodeCount            : {fmt_num(wf_graph.get('nodeCount'))}")
    print(f"[repro] wfGraph.edgeCount            : {fmt_num(wf_graph.get('edgeCount'))}")
    print(f"[repro] wfGraph.elapsedMs            : {fmt_num(wf_graph.get('elapsedMs'))}")
    print(f"[repro] wfGraph.processElapsedMs     : {fmt_num(wf_graph.get('processElapsedMs'))}")

if task_graph is not None:
    print(f"[repro] taskGraph.nodeCount          : {fmt_num(task_graph.get('nodeCount'))}")
    print(f"[repro] taskGraph.elapsedMs          : {fmt_num(task_graph.get('elapsedMs'))}")
    print(f"[repro] taskGraph.processElapsedMs   : {fmt_num(task_graph.get('processElapsedMs'))}")

print(f"[repro] non-forced snapshot_replace after bootstrap: {len(post_bootstrap_non_forced)}")
if startup_applied is not None:
    print(f"[repro] startup_snapshot_applied.forceRefresh : {startup_applied.get('forceRefresh')}")
if startup_skipped is not None:
    print(f"[repro] startup_snapshot_skipped_smaller_than_bootstrap observed (count=1+)")

issue_present = (bootstrap is not None) and (len(post_bootstrap_non_forced) > 0)

if expect_issue:
    if issue_present:
        print("[repro] PASS: redundant non-forced snapshot replace observed after bootstrap (baseline)")
        sys.exit(0)
    print("[repro] FAIL (--expect-issue): no non-forced snapshot_replace after bootstrap was observed")
    if bootstrap is None:
        print("[repro]   -> preload_bootstrap_sync was missing; cannot anchor the check.")
    sys.exit(1)

if issue_present:
    print("[repro] FAIL: redundant non-forced snapshot replace still fires after bootstrap")
    sys.exit(1)
if bootstrap is None:
    print("[repro] FAIL: preload_bootstrap_sync event was not captured; cannot verify the fix")
    sys.exit(1)
print("[repro] PASS: no redundant non-forced snapshot replace after preload_bootstrap_sync")
sys.exit(0)
PY

#!/usr/bin/env bash
# Deterministic repro for the "redundant post-bootstrap startup snapshot"
# overhead.
#
# Hypothesis under test:
#   After preload's synchronous bootstrap IPC delivers the full task/workflow
#   list to the renderer (reported as `preload_bootstrap_sync`), useTasks.ts
#   still issues a non-forced `getTasks()` IPC on mount, producing a second
#   full snapshot reported as `useTasks_snapshot_replace` with
#   `forceRefresh=false`. Observed in production this costs ~65-164ms and
#   ~377KB even though the graph is already visible.
#
# What the script does:
#   1. Provisions an isolated INVOKER_DB_DIR + bare git remote.
#   2. Seeds the DB with multiple workflows/tasks through a Playwright-driven
#      Electron launch (no manual SQL).
#   3. Cleanly closes the seeding app, then relaunches Electron against the
#      same DB so the bootstrap path is exercised against persisted state.
#   4. Waits for the workflow graph to be visible, pulls `activity_log` and
#      `getUiPerfStats()`, and locates:
#        - `preload_bootstrap_sync`
#        - the first `useTasks_snapshot_replace` strictly after it
#        - `startup_workflow_graph_visible` and `startup_graph_visible`
#   5. Prints the required metrics and applies the pass/fail rules below.
#
# Flag semantics (mutually exclusive with the default):
#   --expect-issue : Today's broken behavior. Exit 0 only when a non-forced
#                    `useTasks_snapshot_replace` is observed strictly AFTER
#                    `preload_bootstrap_sync`. Exit 1 if not.
#   (no flag)      : Post-optimization behavior. Exit 0 only when NO
#                    non-forced `useTasks_snapshot_replace` follows
#                    `preload_bootstrap_sync`. Exit 1 if one is observed.
#
# Common exit codes:
#   0  expectation satisfied
#   1  expectation falsified
#   2  setup / infrastructure failure (build missing, Playwright crash, etc)
#
# Tunables (env vars):
#   REPRO_WORKFLOW_COUNT     default 8   (number of seeded workflows)
#   REPRO_TASKS_PER_WORKFLOW default 6   (tasks per seeded workflow)
#   REPRO_STARTUP_BUDGET_MS  default 20000
#   KEEP_REPRO_HOME=1        keep tmp dir for post-mortem inspection

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,40p' "$0"
      exit 0
      ;;
    *)
      echo "[repro] unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

die() { echo "[repro] FATAL: $*" >&2; exit 2; }

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
UI_DIST_INDEX="$ROOT_DIR/packages/ui/dist/index.html"
SURFACES_DIST="$ROOT_DIR/packages/surfaces/dist/index.js"

WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-8}"
TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-6}"
STARTUP_BUDGET_MS="${REPRO_STARTUP_BUDGET_MS:-20000}"

command -v node >/dev/null || die "node not found on PATH"

if [[ ! -f "$APP_MAIN_JS" || ! -f "$UI_DIST_INDEX" || ! -f "$SURFACES_DIST" ]]; then
  echo "[repro] build artifacts missing — running 'pnpm --filter @invoker/app build' (plus ui/surfaces if needed)"
  (cd "$ROOT_DIR" && pnpm --filter @invoker/ui build >/dev/null) || die "pnpm build of @invoker/ui failed"
  (cd "$ROOT_DIR" && pnpm --filter @invoker/surfaces build >/dev/null) || die "pnpm build of @invoker/surfaces failed"
  (cd "$ROOT_DIR" && pnpm --filter @invoker/app build >/dev/null) || die "pnpm build of @invoker/app failed"
fi

STAMP="$(date +%s)-$$"
REPRO_HOME="${TMPDIR:-/tmp}/invoker-repro-startup-snapshot-$STAMP"
DB_DIR="$REPRO_HOME/db"
HOME_DIR="$REPRO_HOME/home"
BARE_REPO="$REPRO_HOME/remote.git"
CONFIG_PATH="$REPRO_HOME/config.json"
MARKER_ROOT="$REPRO_HOME/markers"
CLAUDE_STUB_DIR="$REPRO_HOME/claude-stub"
DRIVER_JS="$REPRO_HOME/driver.cjs"
SEED_OUT="$REPRO_HOME/seed.json"
MEASURE_OUT="$REPRO_HOME/measure.json"

mkdir -p "$DB_DIR" "$HOME_DIR" "$MARKER_ROOT" "$CLAUDE_STUB_DIR"

cleanup() {
  if [[ "${KEEP_REPRO_HOME:-0}" != "1" ]]; then
    rm -rf "$REPRO_HOME" 2>/dev/null || true
  else
    echo "[repro] KEEP_REPRO_HOME=1 — artifacts kept at $REPRO_HOME" >&2
  fi
}
trap cleanup EXIT

echo "[repro] root             : $REPRO_HOME"
echo "[repro] workflows × tasks: ${WORKFLOW_COUNT} × ${TASKS_PER_WORKFLOW}"
echo "[repro] expect-issue     : $EXPECT_ISSUE"

git init --bare --initial-branch=master "$BARE_REPO" >/dev/null
SETUP_CLONE="$REPRO_HOME/setup-clone"
git clone --quiet "$BARE_REPO" "$SETUP_CLONE"
(
  cd "$SETUP_CLONE"
  git -c user.email=ci@invoker.dev -c user.name='Invoker Repro' commit --quiet --allow-empty -m init
  git push --quiet origin HEAD:refs/heads/master
  git push --quiet origin HEAD:refs/heads/main
)
rm -rf "$SETUP_CLONE"

cat > "$CONFIG_PATH" <<'JSON'
{"autoFixRetries":0,"maxConcurrency":1}
JSON

CLAUDE_MARKER="$ROOT_DIR/scripts/e2e-dry-run/fixtures/claude-marker.sh"
[[ -x "$CLAUDE_MARKER" ]] || die "missing claude marker at $CLAUDE_MARKER"
ln -sf "$CLAUDE_MARKER" "$CLAUDE_STUB_DIR/claude"

# Resolve a Playwright @playwright/test install that exports `_electron`.
PLAYWRIGHT_DIR="$(node -e "try{console.log(require.resolve('@playwright/test/package.json',{paths:['$ROOT_DIR/packages/app','$ROOT_DIR']}))}catch(e){process.exit(1)}" 2>/dev/null || true)"
[[ -n "$PLAYWRIGHT_DIR" ]] || die "could not resolve @playwright/test from the repo (pnpm install needed?)"
PLAYWRIGHT_ROOT="$(dirname "$PLAYWRIGHT_DIR")"

ELECTRON_PACKAGE_JSON="$(node -e "try{console.log(require.resolve('electron/package.json',{paths:['$ROOT_DIR/packages/app','$ROOT_DIR']}))}catch(e){process.exit(1)}" 2>/dev/null || true)"
[[ -n "$ELECTRON_PACKAGE_JSON" ]] || die "could not resolve electron package (pnpm install needed?)"

# Detect xvfb-run on Linux so we can render under a virtual display.
XVFB_PREFIX=()
if [[ "$(uname -s)" == "Linux" ]]; then
  if command -v xvfb-run >/dev/null; then
    XVFB_PREFIX=(xvfb-run --auto-servernum)
  else
    echo "[repro] WARN: xvfb-run not found; Electron may fail to open a window on headless Linux" >&2
  fi
fi

# ─── Inline Playwright driver ─────────────────────────────────────────────
cat > "$DRIVER_JS" <<'NODE'
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const { stringify: yamlStringify } = require('yaml');

const mode = process.argv[2];
if (!mode || (mode !== 'seed' && mode !== 'measure')) {
  console.error(`driver: usage: driver.cjs <seed|measure> <outPath>`);
  process.exit(2);
}
const outPath = process.argv[3];
if (!outPath) {
  console.error('driver: missing output path');
  process.exit(2);
}

const playwrightRoot = process.env.REPRO_PLAYWRIGHT_ROOT;
if (!playwrightRoot) {
  console.error('driver: REPRO_PLAYWRIGHT_ROOT is not set');
  process.exit(2);
}
// `_electron` is exported from @playwright/test (and playwright/test).
const { _electron: electron } = require(playwrightRoot);

const APP_MAIN = process.env.REPRO_APP_MAIN;
const DB_DIR = process.env.REPRO_DB_DIR;
const CONFIG_PATH = process.env.REPRO_CONFIG_PATH;
const MARKER_ROOT = process.env.REPRO_MARKER_ROOT;
const CLAUDE_STUB_DIR = process.env.REPRO_CLAUDE_STUB_DIR;
const BARE_REPO = process.env.REPRO_BARE_REPO;
const WORKFLOW_COUNT = Number.parseInt(process.env.REPRO_WORKFLOW_COUNT || '8', 10);
const TASKS_PER_WORKFLOW = Number.parseInt(process.env.REPRO_TASKS_PER_WORKFLOW || '6', 10);
const STARTUP_BUDGET_MS = Number.parseInt(process.env.REPRO_STARTUP_BUDGET_MS || '20000', 10);

for (const [k, v] of Object.entries({
  REPRO_APP_MAIN: APP_MAIN,
  REPRO_DB_DIR: DB_DIR,
  REPRO_CONFIG_PATH: CONFIG_PATH,
  REPRO_MARKER_ROOT: MARKER_ROOT,
  REPRO_CLAUDE_STUB_DIR: CLAUDE_STUB_DIR,
  REPRO_BARE_REPO: BARE_REPO,
})) {
  if (!v) {
    console.error(`driver: missing required env ${k}`);
    process.exit(2);
  }
}

const CLAUDE_MARKER = path.join(CLAUDE_STUB_DIR, 'claude');
const PATH_ENV = `${CLAUDE_STUB_DIR}${path.delimiter}${process.env.PATH ?? ''}`;
const REPO_URL = pathToFileURL(BARE_REPO).href;

function buildPlan(index) {
  return {
    name: `Repro Startup Snapshot ${index}`,
    repoUrl: REPO_URL,
    onFinish: 'none',
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Task ${index}-${taskIndex}`,
      command: `echo task-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

function launch() {
  const linuxFlags =
    process.platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-gpu-compositing',
          '--disable-gpu-sandbox',
          '--disable-software-rasterizer',
        ]
      : [];
  return electron.launch({
    args: [...linuxFlags, APP_MAIN],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: DB_DIR,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
      INVOKER_E2E_MARKER_ROOT: MARKER_ROOT,
      INVOKER_CLAUDE_COMMAND: CLAUDE_MARKER,
      INVOKER_CLAUDE_FIX_COMMAND: CLAUDE_MARKER,
      PATH: PATH_ENV,
    },
  });
}

async function withApp(fn) {
  const app = await launch();
  try {
    return await fn(app);
  } finally {
    try { await app.close(); } catch { /* ignore */ }
  }
}

async function waitForReady(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 5000 });
}

async function seed() {
  await withApp(async (app) => {
    const page = await app.firstWindow({ timeout: STARTUP_BUDGET_MS });
    await waitForReady(page);
    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      const planYaml = yamlStringify(buildPlan(i));
      await page.evaluate(async (planText) => {
        await window.invoker.loadPlan(planText);
      }, planYaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    const expected = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    if (seededTasks.length !== expected) {
      throw new Error(`seed: expected ${expected} tasks, persisted ${seededTasks.length}`);
    }
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        {
          taskCount: seededTasks.length,
          workflowCount: WORKFLOW_COUNT,
          tasksPerWorkflow: TASKS_PER_WORKFLOW,
        },
        null,
        2,
      ),
    );
  });
}

async function measure() {
  await withApp(async (app) => {
    const page = await app.firstWindow({ timeout: STARTUP_BUDGET_MS });
    await waitForReady(page);
    // Wait for at least one workflow node to render so `startup_workflow_graph_visible`
    // and (downstream) any extra non-forced snapshot replace have a chance to fire.
    await page
      .locator('[data-testid^="workflow-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: STARTUP_BUDGET_MS });
    // Give useTasks's on-mount fetchAll() a moment to land its IPC reply.
    await page.waitForTimeout(750);

    const payload = await page.evaluate(async () => {
      const activityLogs = await window.invoker.getActivityLogs();
      const perf = await window.invoker.getUiPerfStats();
      const tasksResult = await window.invoker.getTasks(true);
      const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
      return { activityLogs, perf, taskCount: tasks.length };
    });
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));
  });
}

(async () => {
  try {
    if (mode === 'seed') {
      await seed();
    } else {
      await measure();
    }
  } catch (err) {
    console.error(`driver: ${mode} failed:`, err && err.stack ? err.stack : err);
    process.exit(2);
  }
})();
NODE

export REPRO_PLAYWRIGHT_ROOT="$PLAYWRIGHT_ROOT"
export REPRO_APP_MAIN="$APP_MAIN_JS"
export REPRO_DB_DIR="$DB_DIR"
export REPRO_CONFIG_PATH="$CONFIG_PATH"
export REPRO_MARKER_ROOT="$MARKER_ROOT"
export REPRO_CLAUDE_STUB_DIR="$CLAUDE_STUB_DIR"
export REPRO_BARE_REPO="$BARE_REPO"
export REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
export REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
export REPRO_STARTUP_BUDGET_MS="$STARTUP_BUDGET_MS"
export HOME="$HOME_DIR"

echo "[repro] [1/2] seeding ${WORKFLOW_COUNT} workflows × ${TASKS_PER_WORKFLOW} tasks…"
"${XVFB_PREFIX[@]}" node "$DRIVER_JS" seed "$SEED_OUT" || die "seed phase failed"

echo "[repro] [2/2] measuring restart bootstrap…"
"${XVFB_PREFIX[@]}" node "$DRIVER_JS" measure "$MEASURE_OUT" || die "measure phase failed"

[[ -s "$SEED_OUT"    ]] || die "seed phase produced no output"
[[ -s "$MEASURE_OUT" ]] || die "measure phase produced no output"

# ─── Analyze captured payload ─────────────────────────────────────────────
SUMMARY="$REPRO_HOME/summary.json"
ANALYZE_JS="$REPRO_HOME/analyze.cjs"
cat > "$ANALYZE_JS" <<'NODE'
'use strict';
const fs = require('node:fs');

const measurePath = process.argv[2];
const outPath = process.argv[3];
const payload = JSON.parse(fs.readFileSync(measurePath, 'utf8'));

function parsePayload(message) {
  try { return JSON.parse(message); } catch { return null; }
}

const perfEntries = (payload.activityLogs || [])
  .filter((entry) => entry.source === 'ui-perf')
  .map((entry) => ({ id: entry.id, payload: parsePayload(entry.message) }))
  .filter((entry) => entry.payload && typeof entry.payload.metric === 'string');

const bootstrap = perfEntries.find((e) => e.payload.metric === 'preload_bootstrap_sync');
const graphVisible = perfEntries.find((e) => e.payload.metric === 'startup_workflow_graph_visible');
const taskGraphVisible = perfEntries.find((e) => e.payload.metric === 'startup_graph_visible');

const snapshotReplaces = perfEntries
  .filter((e) => e.payload.metric === 'useTasks_snapshot_replace')
  .sort((a, b) => a.id - b.id);

// "After bootstrap" = activity_log id strictly greater than the bootstrap entry's id.
const postBootstrapReplaces = bootstrap
  ? snapshotReplaces.filter((e) => e.id > bootstrap.id)
  : snapshotReplaces;

const redundantReplace = postBootstrapReplaces.find((e) => e.payload.forceRefresh === false);

const firstReplace = snapshotReplaces[0]?.payload;
const redundantPayload = redundantReplace?.payload;

const summary = {
  taskCount: payload.taskCount,
  bootstrap: bootstrap
    ? {
        taskCount: bootstrap.payload.taskCount,
        workflowCount: bootstrap.payload.workflowCount,
        jsonSizeBytes: bootstrap.payload.jsonSizeBytes,
        durationMs: bootstrap.payload.durationMs,
        activityLogId: bootstrap.id,
      }
    : null,
  graphVisible: graphVisible
    ? {
        nodeCount: graphVisible.payload.nodeCount,
        edgeCount: graphVisible.payload.edgeCount,
        elapsedMs: graphVisible.payload.elapsedMs,
        processElapsedMs: graphVisible.payload.processElapsedMs,
        activityLogId: graphVisible.id,
      }
    : null,
  taskGraphVisible: taskGraphVisible
    ? {
        nodeCount: taskGraphVisible.payload.nodeCount,
        elapsedMs: taskGraphVisible.payload.elapsedMs,
        processElapsedMs: taskGraphVisible.payload.processElapsedMs,
        activityLogId: taskGraphVisible.id,
      }
    : null,
  snapshotReplaces: snapshotReplaces.map((e) => ({
    activityLogId: e.id,
    forceRefresh: e.payload.forceRefresh,
    requestDurationMs: e.payload.requestDurationMs,
    replaceDurationMs: e.payload.replaceDurationMs,
    jsonSizeBytes: e.payload.jsonSizeBytes,
    taskCount: e.payload.taskCount,
    workflowCount: e.payload.workflowCount,
    afterBootstrap: bootstrap ? e.id > bootstrap.id : false,
  })),
  firstSnapshotReplace: firstReplace
    ? {
        forceRefresh: firstReplace.forceRefresh,
        requestDurationMs: firstReplace.requestDurationMs,
        replaceDurationMs: firstReplace.replaceDurationMs,
        jsonSizeBytes: firstReplace.jsonSizeBytes,
      }
    : null,
  redundantPostBootstrapReplace: redundantPayload
    ? {
        activityLogId: redundantReplace.id,
        forceRefresh: redundantPayload.forceRefresh,
        requestDurationMs: redundantPayload.requestDurationMs,
        replaceDurationMs: redundantPayload.replaceDurationMs,
        jsonSizeBytes: redundantPayload.jsonSizeBytes,
        taskCount: redundantPayload.taskCount,
        workflowCount: redundantPayload.workflowCount,
      }
    : null,
};

fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));
NODE

node "$ANALYZE_JS" "$MEASURE_OUT" "$SUMMARY" || die "analysis failed"

# Extract individual values for printing / branching.
read_field() {
  # Usage: read_field <jq-style path> — returns JS undefined as empty string.
  node -e "
    const s = JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));
    const v = (function(){try{return $1;}catch(e){return undefined;}})();
    process.stdout.write(v === undefined || v === null ? '' : String(v));
  " "$SUMMARY"
}

BOOTSTRAP_TASK_COUNT=$(read_field "s.bootstrap.taskCount")
BOOTSTRAP_WF_COUNT=$(read_field "s.bootstrap.workflowCount")
BOOTSTRAP_JSON_BYTES=$(read_field "s.bootstrap.jsonSizeBytes")
GRAPH_NODE_COUNT=$(read_field "s.graphVisible.nodeCount")
GRAPH_EDGE_COUNT=$(read_field "s.graphVisible.edgeCount")
GRAPH_ELAPSED_MS=$(read_field "s.graphVisible.processElapsedMs ?? s.graphVisible.elapsedMs")
REDUNDANT_FORCED=$(read_field "s.redundantPostBootstrapReplace.forceRefresh")
REDUNDANT_REQ_MS=$(read_field "s.redundantPostBootstrapReplace.requestDurationMs")
REDUNDANT_REP_MS=$(read_field "s.redundantPostBootstrapReplace.replaceDurationMs")
FIRST_FORCED=$(read_field "s.firstSnapshotReplace.forceRefresh")
FIRST_REQ_MS=$(read_field "s.firstSnapshotReplace.requestDurationMs")
FIRST_REP_MS=$(read_field "s.firstSnapshotReplace.replaceDurationMs")

echo
echo "[repro] ───────── captured metrics ─────────"
echo "[repro] bootstrap.taskCount               : ${BOOTSTRAP_TASK_COUNT:-<missing>}"
echo "[repro] bootstrap.workflowCount           : ${BOOTSTRAP_WF_COUNT:-<missing>}"
echo "[repro] bootstrap.jsonSizeBytes           : ${BOOTSTRAP_JSON_BYTES:-<missing>}"
echo "[repro] graph.nodeCount                   : ${GRAPH_NODE_COUNT:-<missing>}"
echo "[repro] graph.edgeCount                   : ${GRAPH_EDGE_COUNT:-<missing>}"
echo "[repro] graph.visibleAtMs (process)       : ${GRAPH_ELAPSED_MS:-<missing>}"
echo "[repro] first snapshot.forceRefresh       : ${FIRST_FORCED:-<missing>}"
echo "[repro] first snapshot.requestDurationMs  : ${FIRST_REQ_MS:-<missing>}"
echo "[repro] first snapshot.replaceDurationMs  : ${FIRST_REP_MS:-<missing>}"
echo "[repro] post-bootstrap snapshot.forceRefresh      : ${REDUNDANT_FORCED:-<none>}"
echo "[repro] post-bootstrap snapshot.requestDurationMs : ${REDUNDANT_REQ_MS:-<none>}"
echo "[repro] post-bootstrap snapshot.replaceDurationMs : ${REDUNDANT_REP_MS:-<none>}"
echo "[repro] summary JSON                      : $SUMMARY"
echo "[repro] ─────────────────────────────────────"

# Decision:
#   - "Redundant" = a `useTasks_snapshot_replace` record with
#      forceRefresh === false that landed AFTER `preload_bootstrap_sync`.
HAS_REDUNDANT=0
if [[ "$REDUNDANT_FORCED" == "false" ]]; then
  HAS_REDUNDANT=1
fi

if [[ -z "$BOOTSTRAP_TASK_COUNT" ]]; then
  echo "[repro] FAIL: no preload_bootstrap_sync entry captured — fixture did not exercise bootstrap" >&2
  exit 1
fi

if [[ "$EXPECT_ISSUE" -eq 1 ]]; then
  if [[ "$HAS_REDUNDANT" -eq 1 ]]; then
    echo "[repro] PASS (--expect-issue): observed non-forced useTasks_snapshot_replace after preload_bootstrap_sync"
    exit 0
  fi
  echo "[repro] FAIL (--expect-issue): expected a redundant post-bootstrap non-forced snapshot, but did not observe one" >&2
  exit 1
fi

if [[ "$HAS_REDUNDANT" -eq 1 ]]; then
  echo "[repro] FAIL: redundant non-forced useTasks_snapshot_replace still happens after preload_bootstrap_sync" >&2
  exit 1
fi
echo "[repro] PASS: no redundant non-forced startup snapshot after preload_bootstrap_sync"
exit 0

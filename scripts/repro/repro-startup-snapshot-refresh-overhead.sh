#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot.
#
# The preload script synchronously pumps the full task graph into the renderer
# via __INVOKER_BOOTSTRAP__, but `useTasks`'s mount effect still fires a
# non-forced getTasks() and snapshot replace right after preload, redundantly
# re-fetching and re-applying state that is already painted. Recent perf data
# put that redundant call at ~65–164ms and ~377KB after the graph was visible.
#
# Pipeline:
#   1. Provision an isolated INVOKER_DB_DIR and a local bare git repo so
#      `window.invoker.loadPlan` can clone without network.
#   2. Launch Electron once (seed phase) and create N workflows × M tasks.
#   3. Close, then launch Electron again (measure phase) against the seeded DB.
#   4. Wait for the workflow graph node to render, then read activity_log via
#      `window.invoker.getActivityLogs()`. Surface the ui-perf entries needed
#      to characterize the redundant snapshot:
#        - preload_bootstrap_sync taskCount / workflowCount / jsonSizeBytes
#        - useTasks_snapshot_replace requestDurationMs / replaceDurationMs /
#          jsonSizeBytes / forceRefresh
#        - startup_workflow_graph_visible + startup_graph_visible timing and
#          node/edge counts
#        - whether the snapshot was forced (`forceRefresh`)
#
# Exit codes:
#   --expect-issue (today's baseline):
#     0  redundant non-forced useTasks_snapshot_replace observed after
#        preload_bootstrap_sync (bug present, as expected)
#     1  redundant snapshot NOT observed (claim falsified — bug already gone?)
#   no flag (post-optimization):
#     0  no redundant non-forced startup snapshot observed (fix holds)
#     1  redundant snapshot still occurs after bootstrap (regression)
#   2  infra / setup failure
#   64 unknown flag
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#                                                            [--workflows N]
#                                                            [--tasks-per-workflow M]
#                                                            [--keep-tmp]

set -euo pipefail

EXPECT_ISSUE=0
WORKFLOW_COUNT=10
TASKS_PER_WORKFLOW=7
KEEP_TMP=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    --workflows) WORKFLOW_COUNT="$2"; shift 2 ;;
    --tasks-per-workflow) TASKS_PER_WORKFLOW="$2"; shift 2 ;;
    --keep-tmp) KEEP_TMP=1; shift ;;
    -h|--help)
      awk 'NR > 1 && /^#/ { sub(/^#[ ]?/, ""); print; next } NR > 1 { exit }' "$0"
      exit 0
      ;;
    *) echo "[repro] unknown flag: $1" >&2; exit 64 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
APP_MAIN_JS="$APP_DIR/dist/main.js"

die() { echo "[repro] FATAL: $*" >&2; exit 2; }

# Build the Electron app if dist artifacts are missing; CI / fresh worktrees
# need this on the first invocation.
if [[ ! -f "$APP_MAIN_JS" ]]; then
  echo "[repro] building @invoker/app (missing $APP_MAIN_JS) ..." >&2
  (cd "$REPO_ROOT" && pnpm --filter @invoker/ui build >&2) || die "pnpm build (ui) failed"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/surfaces build >&2) || die "pnpm build (surfaces) failed"
  (cd "$REPO_ROOT" && pnpm --filter @invoker/app build >&2) || die "pnpm build (app) failed"
fi
[[ -f "$APP_MAIN_JS" ]] || die "missing $APP_MAIN_JS after build"

PLAYWRIGHT_PKG="$APP_DIR/node_modules/@playwright/test/package.json"
YAML_PKG="$APP_DIR/node_modules/yaml/package.json"
[[ -f "$PLAYWRIGHT_PKG" ]] || die "missing @playwright/test under $APP_DIR/node_modules (run 'pnpm install')"
[[ -f "$YAML_PKG" ]] || die "missing yaml under $APP_DIR/node_modules (run 'pnpm install')"
command -v git >/dev/null || die "git CLI not found"
command -v node >/dev/null || die "node not found"

STAMP="$(date +%s)-$$"
TMP_ROOT="${TMPDIR:-/tmp}/invoker-repro-startup-snapshot-$STAMP"
DB_DIR="$TMP_ROOT/db"
BARE_REPO="$TMP_ROOT/seed.git"
CONFIG_JSON="$TMP_ROOT/repo-config.json"
RESULT_JSON="$TMP_ROOT/result.json"
DRIVER_JS="$TMP_ROOT/driver.cjs"
mkdir -p "$DB_DIR"

cleanup() {
  if [[ "$KEEP_TMP" == "1" ]]; then
    echo "[repro] preserving $TMP_ROOT (--keep-tmp)" >&2
    return
  fi
  rm -rf "$TMP_ROOT" 2>/dev/null || true
}
trap cleanup EXIT

# Disable auto-run so the seeded tasks do not actually execute during the
# measure-phase startup — task execution would noise up the activity log and
# could overlap with the post-bootstrap snapshot we are trying to observe.
cat > "$CONFIG_JSON" <<'JSON'
{ "autoFixRetries": 0, "disableAutoRunOnStartup": true }
JSON

# Build a tiny local bare repo so loadPlan's WorktreeExecutor can clone offline.
(
  unset GIT_DIR GIT_WORK_TREE
  export GIT_AUTHOR_NAME="${GIT_AUTHOR_NAME:-Invoker Repro}"
  export GIT_AUTHOR_EMAIL="${GIT_AUTHOR_EMAIL:-repro@invoker.dev}"
  export GIT_COMMITTER_NAME="${GIT_COMMITTER_NAME:-$GIT_AUTHOR_NAME}"
  export GIT_COMMITTER_EMAIL="${GIT_COMMITTER_EMAIL:-$GIT_AUTHOR_EMAIL}"
  git init --bare "$BARE_REPO" >/dev/null
  SETUP_CLONE="$TMP_ROOT/seed-clone"
  git clone "$BARE_REPO" "$SETUP_CLONE" >/dev/null 2>&1
  cd "$SETUP_CLONE"
  git commit --allow-empty -m "init" >/dev/null
  git push origin HEAD:refs/heads/master >/dev/null 2>&1
  git push origin HEAD:refs/heads/main   >/dev/null 2>&1
  cd "$TMP_ROOT"
  rm -rf "$SETUP_CLONE"
)
REPO_URL="file://$BARE_REPO"

# On a headless Linux box without DISPLAY we need xvfb-run; macOS / WSLg are fine.
NODE_RUNNER=( node )
if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" ]]; then
  if command -v xvfb-run >/dev/null; then
    NODE_RUNNER=( xvfb-run -a node )
  else
    die "Linux without DISPLAY and xvfb-run not installed"
  fi
fi

echo "[repro] tmp root            : $TMP_ROOT"
echo "[repro] workflows × tasks   : $WORKFLOW_COUNT × $TASKS_PER_WORKFLOW"
echo "[repro] expect-issue        : $EXPECT_ISSUE"

cat > "$DRIVER_JS" <<'NODE'
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const APP_DIR        = process.env.INVOKER_REPRO_APP_DIR;
const APP_MAIN_JS    = process.env.INVOKER_REPRO_APP_MAIN_JS;
const DB_DIR         = process.env.INVOKER_DB_DIR;
const RESULT_JSON    = process.env.INVOKER_REPRO_RESULT_JSON;
const REPO_URL       = process.env.INVOKER_REPRO_REPO_URL;
const CONFIG_JSON    = process.env.INVOKER_REPRO_CONFIG_JSON;
const WORKFLOW_COUNT = Number(process.env.INVOKER_REPRO_WORKFLOW_COUNT);
const TASKS_PER_WORKFLOW = Number(process.env.INVOKER_REPRO_TASKS_PER_WORKFLOW);

if (!APP_DIR || !APP_MAIN_JS || !DB_DIR || !RESULT_JSON || !REPO_URL || !CONFIG_JSON) {
  console.error('[repro] driver: missing required INVOKER_REPRO_* env');
  process.exit(2);
}

const { _electron: electron } = require(path.join(APP_DIR, 'node_modules', '@playwright', 'test'));
const { stringify: yamlStringify } = require(path.join(APP_DIR, 'node_modules', 'yaml'));

const log = (...m) => console.error('[repro]', ...m);

function launchArgs() {
  const linuxFlags = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-gpu-compositing',
    '--disable-gpu-sandbox',
    '--disable-software-rasterizer',
  ];
  return [
    ...(process.platform === 'linux' ? linuxFlags : []),
    APP_MAIN_JS,
  ];
}

function launchEnv(extra) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_ALLOW_DELETE_ALL: '1',
    INVOKER_REPO_CONFIG_PATH: CONFIG_JSON,
    ...(extra || {}),
  };
}

function buildPlan(index) {
  return {
    name: `Startup Snapshot Repro Plan ${index}`,
    repoUrl: REPO_URL,
    onFinish: 'none',
    tasks: Array.from({ length: TASKS_PER_WORKFLOW }, (_, i) => ({
      id: `task-${index}-${i}`,
      description: `Task ${index}-${i}`,
      command: `echo task-${index}-${i}`,
      dependencies: i === 0 ? [] : [`task-${index}-${i - 1}`],
    })),
  };
}

async function pollForReplaceEntry(page, bootstrapId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let entries = [];
  while (Date.now() < deadline) {
    const activity = await page.evaluate(() => window.invoker.getActivityLogs());
    entries = activity
      .filter((e) => e.source === 'ui-perf')
      .map((e) => { try { return { id: e.id, payload: JSON.parse(e.message) }; } catch { return null; } })
      .filter(Boolean);
    const replaceSeen = entries.some((e) =>
      e.payload && e.payload.metric === 'useTasks_snapshot_replace'
      && (bootstrapId == null || e.id > bootstrapId),
    );
    const bootstrapSeen = entries.some((e) => e.payload && e.payload.metric === 'preload_bootstrap_sync');
    if (replaceSeen && bootstrapSeen) return entries;
    await page.waitForTimeout(150);
  }
  return entries;
}

(async () => {
  // ── Seed phase ────────────────────────────────────────────────
  log('seeding', WORKFLOW_COUNT, 'workflows ×', TASKS_PER_WORKFLOW, 'tasks ...');
  const seedApp = await electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await seedApp.firstWindow({ timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15000 });
    for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
      const yaml = yamlStringify(buildPlan(i));
      await page.evaluate(async (planText) => {
        await window.invoker.loadPlan(planText);
      }, yaml);
    }
    const seeded = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(seeded) ? seeded : seeded.tasks;
    const expected = WORKFLOW_COUNT * TASKS_PER_WORKFLOW;
    if (tasks.length !== expected) {
      throw new Error(`seed mismatch: got ${tasks.length} tasks, expected ${expected}`);
    }
    log('seed complete: tasks=' + tasks.length);
  } finally {
    await seedApp.close();
  }

  // ── Measure phase ─────────────────────────────────────────────
  log('measuring startup against seeded DB ...');
  const startedAtMs = Date.now();
  const app = await electron.launch({ args: launchArgs(), env: launchEnv() });
  try {
    const page = await app.firstWindow({ timeout: 20000 });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15000 });

    // The graph-visible perf entries fire once a workflow node renders.
    await page.locator('[data-testid^="workflow-node-"]').first()
      .waitFor({ state: 'visible', timeout: 25000 });

    // Pull a first cut of activity logs to grab the bootstrap entry id, then
    // poll until the post-bootstrap snapshot_replace lands (or we hit a deadline).
    let firstPass = await page.evaluate(() => window.invoker.getActivityLogs());
    const firstPassUiPerf = firstPass
      .filter((e) => e.source === 'ui-perf')
      .map((e) => { try { return { id: e.id, payload: JSON.parse(e.message) }; } catch { return null; } })
      .filter(Boolean);
    const bootstrapFirst = firstPassUiPerf.find((e) => e.payload && e.payload.metric === 'preload_bootstrap_sync');
    const entries = await pollForReplaceEntry(page, bootstrapFirst ? bootstrapFirst.id : null, 5000);

    const byMetric = (m) => entries.find((e) => e.payload && e.payload.metric === m);
    const bootstrap = byMetric('preload_bootstrap_sync');
    const graphVisible = byMetric('startup_workflow_graph_visible');
    const taskGraphVisible = byMetric('startup_graph_visible');
    const skipped = byMetric('startup_snapshot_skipped_smaller_than_bootstrap');

    // First non-forced useTasks_snapshot_replace that landed after preload_bootstrap_sync.
    const replaceAfterBootstrap = entries.find((e) =>
      e.payload
      && e.payload.metric === 'useTasks_snapshot_replace'
      && (!bootstrap || e.id > bootstrap.id)
      && e.payload.forceRefresh === false,
    );

    // Any useTasks_snapshot_replace at all (forced or not) — useful diagnostic.
    const anyReplace = entries.find((e) => e.payload && e.payload.metric === 'useTasks_snapshot_replace');

    const result = {
      sawRedundantSnapshot: Boolean(replaceAfterBootstrap),
      coldStartElapsedMs: Date.now() - startedAtMs,
      bootstrap: bootstrap ? bootstrap.payload : null,
      replace: replaceAfterBootstrap ? replaceAfterBootstrap.payload : null,
      replaceAny: anyReplace ? anyReplace.payload : null,
      graphVisible: graphVisible ? graphVisible.payload : null,
      taskGraphVisible: taskGraphVisible ? taskGraphVisible.payload : null,
      skipped: skipped ? skipped.payload : null,
    };
    fs.writeFileSync(RESULT_JSON, JSON.stringify(result));
    log('result written to', RESULT_JSON);
  } finally {
    await app.close();
  }
})().catch((err) => {
  console.error('[repro] driver failed:', err && err.stack ? err.stack : err);
  process.exit(2);
});
NODE

INVOKER_DB_DIR="$DB_DIR" \
INVOKER_REPRO_RESULT_JSON="$RESULT_JSON" \
INVOKER_REPRO_REPO_URL="$REPO_URL" \
INVOKER_REPRO_CONFIG_JSON="$CONFIG_JSON" \
INVOKER_REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
INVOKER_REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
INVOKER_REPRO_APP_MAIN_JS="$APP_MAIN_JS" \
INVOKER_REPRO_APP_DIR="$APP_DIR" \
"${NODE_RUNNER[@]}" "$DRIVER_JS"

[[ -s "$RESULT_JSON" ]] || die "driver produced no result at $RESULT_JSON"

# Render the human-readable report using node so we do not add a python dep.
node --input-type=module -e "
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
const b = p.bootstrap || {};
const r = p.replace || {};
const rAny = p.replaceAny || {};
const g = p.graphVisible || {};
const t = p.taskGraphVisible || {};
const s = p.skipped;
const v = (x) => x === undefined || x === null ? 'n/a' : x;
console.log('───── repro report ──────────────────────────────────────────────');
console.log('  preload_bootstrap_sync.taskCount             =', v(b.taskCount));
console.log('  preload_bootstrap_sync.workflowCount         =', v(b.workflowCount));
console.log('  preload_bootstrap_sync.jsonSizeBytes         =', v(b.jsonSizeBytes));
console.log('  preload_bootstrap_sync.durationMs            =', v(b.durationMs));
if (p.replace) {
  console.log('  useTasks_snapshot_replace.requestDurationMs  =', v(r.requestDurationMs));
  console.log('  useTasks_snapshot_replace.replaceDurationMs  =', v(r.replaceDurationMs));
  console.log('  useTasks_snapshot_replace.jsonSizeBytes      =', v(r.jsonSizeBytes));
  console.log('  useTasks_snapshot_replace.taskCount          =', v(r.taskCount));
  console.log('  useTasks_snapshot_replace.workflowCount      =', v(r.workflowCount));
  console.log('  useTasks_snapshot_replace.forceRefresh       =', v(r.forceRefresh));
} else if (p.replaceAny) {
  console.log('  useTasks_snapshot_replace (forced only)      = forceRefresh=' + v(rAny.forceRefresh)
    + ' requestDurationMs=' + v(rAny.requestDurationMs)
    + ' replaceDurationMs=' + v(rAny.replaceDurationMs));
} else {
  console.log('  useTasks_snapshot_replace.*                  = (none observed)');
}
console.log('  startup_workflow_graph_visible.elapsedMs     =', v(g.elapsedMs));
console.log('  startup_workflow_graph_visible.nodeCount     =', v(g.nodeCount));
console.log('  startup_workflow_graph_visible.edgeCount     =', v(g.edgeCount));
console.log('  startup_graph_visible.elapsedMs              =', v(t.elapsedMs));
console.log('  startup_graph_visible.nodeCount              =', v(t.nodeCount));
console.log('  startup_snapshot_skipped_smaller_than_bootstrap =', s ? JSON.stringify(s) : '(not observed)');
console.log('  cold-start wall time                         =', v(p.coldStartElapsedMs), 'ms');
console.log('  saw redundant non-forced post-bootstrap snapshot =', p.sawRedundantSnapshot);
console.log('────────────────────────────────────────────────────────────────');
" "$RESULT_JSON"

SAW="$(node -e 'const p=require(process.argv[1]); process.stdout.write(p.sawRedundantSnapshot ? "1" : "0");' "$RESULT_JSON")"

if [[ "$EXPECT_ISSUE" == "1" ]]; then
  if [[ "$SAW" == "1" ]]; then
    echo "[repro] PASS (baseline): redundant non-forced startup snapshot observed."
    exit 0
  fi
  echo "[repro] FAIL: --expect-issue set but no redundant non-forced post-bootstrap snapshot observed." >&2
  exit 1
else
  if [[ "$SAW" == "0" ]]; then
    echo "[repro] PASS: no redundant non-forced startup snapshot observed."
    exit 0
  fi
  echo "[repro] FAIL: redundant non-forced startup snapshot still occurs after preload bootstrap." >&2
  exit 1
fi

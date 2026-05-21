#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot.
#
# After preload populates window.__INVOKER_BOOTSTRAP__ (and emits the
# `preload_bootstrap_sync` ui-perf event), useTasks.fetchAll() unconditionally
# re-runs window.invoker.getTasks(false), which fires a non-forced
# `useTasks_snapshot_replace` that re-serializes and re-applies the same data
# the bootstrap already supplied (~377KB / 65-164ms in current measurements).
#
# This script seeds an isolated SQLite DB with multiple workflows/tasks,
# launches the Electron GUI under Playwright, captures the `ui-perf` and
# `activity_log` rows that fire during startup, and reports them.
#
# Usage:
#   scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]
#
# Modes:
#   --expect-issue   Expect the broken baseline: exit 0 iff a non-forced
#                    `useTasks_snapshot_replace` is observed after
#                    `preload_bootstrap_sync`. Use this until the fix lands.
#   (no flag)        Expect the optimized build: exit 0 iff NO non-forced
#                    redundant startup snapshot is observed. Use this after
#                    the fix lands so CI keeps the regression locked down.
#
# Env overrides:
#   WORKFLOW_COUNT          (default 12)   Workflows to seed.
#   TASKS_PER_WORKFLOW      (default 6)    Tasks per workflow.
#   WAIT_AFTER_GRAPH_MS     (default 2500) Settle window after graph visible.
#   STARTUP_TIMEOUT_MS      (default 60000) firstWindow + graph wait budget.

set -euo pipefail

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue) EXPECT_ISSUE=1 ;;
    -h|--help)
      sed -n '2,30p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

WORKFLOW_COUNT="${WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${TASKS_PER_WORKFLOW:-6}"
WAIT_AFTER_GRAPH_MS="${WAIT_AFTER_GRAPH_MS:-2500}"
STARTUP_TIMEOUT_MS="${STARTUP_TIMEOUT_MS:-60000}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d -t invoker-snapshot-repro-XXXXXX)"
DB_DIR="$TMP_DIR/db"
HOME_DIR="$TMP_DIR/home"
REMOTE_REPO="$TMP_DIR/remote.git"
REMOTE_SETUP="$TMP_DIR/remote-setup"
CONFIG_PATH="$TMP_DIR/config.json"
IPC_SOCKET="$TMP_DIR/ipc.sock"
MARKER_ROOT="$TMP_DIR/markers"
STUB_DIR="$TMP_DIR/claude-stub"
DRIVER_JS="$TMP_DIR/driver.cjs"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

mkdir -p "$DB_DIR" "$HOME_DIR" "$MARKER_ROOT" "$STUB_DIR"
cd "$ROOT_DIR"

if [[ ! -f packages/app/dist/main.js \
   || ! -f packages/app/dist/preload.js \
   || ! -f packages/ui/dist/index.html ]]; then
  echo "repro: building Invoker dist artifacts..." >&2
  pnpm --filter @invoker/core build >&2
  pnpm --filter @invoker/persistence build >&2
  pnpm --filter @invoker/executors build >&2
  pnpm --filter @invoker/surfaces build >&2
  pnpm --filter @invoker/ui build >&2
  pnpm --filter @invoker/app build >&2
fi

CLAUDE_MARKER="$ROOT_DIR/scripts/e2e-dry-run/fixtures/claude-marker.sh"
if [[ -x "$CLAUDE_MARKER" ]]; then
  ln -sf "$CLAUDE_MARKER" "$STUB_DIR/claude" 2>/dev/null || true
fi

cat > "$CONFIG_PATH" <<'EOF'
{"autoFixRetries":0,"defaultBranch":"master"}
EOF

git init --bare "$REMOTE_REPO" >/dev/null 2>&1
git clone --quiet "$REMOTE_REPO" "$REMOTE_SETUP"
(
  cd "$REMOTE_SETUP"
  git -c user.email=ci@invoker.dev -c user.name="Invoker Repro" \
    commit --allow-empty --quiet -m "init"
  git push --quiet origin HEAD:refs/heads/master
  git push --quiet origin HEAD:refs/heads/main
)
rm -rf "$REMOTE_SETUP"

cat > "$DRIVER_JS" <<'NODE_EOF'
"use strict";
/**
 * Playwright-driven Electron harness for the startup-snapshot repro.
 *
 *   Phase 1 (seed)   : launches the GUI against an empty isolated DB,
 *                       calls invoker.loadPlan() N times to persist
 *                       workflows/tasks without dispatching them, then exits.
 *   Phase 2 (verify) : relaunches the GUI; the second startup hits the
 *                       persisted state through both preload bootstrap and
 *                       the useTasks() snapshot replace path. Captures
 *                       ui-perf / activity_log rows and decides pass/fail.
 */

const path = require('node:path');

const REPO_ROOT = process.env.INVOKER_REPO_ROOT;
const DB_DIR = process.env.INVOKER_DB_DIR;
const IPC_SOCKET = process.env.INVOKER_IPC_SOCKET;
const MARKER_ROOT = process.env.INVOKER_E2E_MARKER_ROOT;
const CONFIG_PATH = process.env.INVOKER_REPO_CONFIG_PATH;
const REMOTE_REPO = process.env.INVOKER_REMOTE_REPO;
const STUB_DIR = process.env.INVOKER_STUB_DIR;
const CLAUDE_MARKER = process.env.INVOKER_CLAUDE_MARKER;
const MAIN_JS = path.join(REPO_ROOT, 'packages/app/dist/main.js');

const APP_NM = path.join(REPO_ROOT, 'packages/app/node_modules');
const { _electron: electron } = require(path.join(APP_NM, '@playwright/test'));
const yaml = require(path.join(APP_NM, 'yaml'));

const WORKFLOW_COUNT = Number(process.env.WORKFLOW_COUNT || '12');
const TASKS_PER_WORKFLOW = Number(process.env.TASKS_PER_WORKFLOW || '6');
const WAIT_AFTER_GRAPH_MS = Number(process.env.WAIT_AFTER_GRAPH_MS || '2500');
const STARTUP_TIMEOUT_MS = Number(process.env.STARTUP_TIMEOUT_MS || '60000');
const EXPECT_ISSUE = process.env.EXPECT_ISSUE === '1';

function launchArgs() {
  return process.platform === 'linux'
    ? [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-gpu-compositing',
        '--disable-gpu-sandbox',
        '--disable-software-rasterizer',
      ]
    : [];
}

function envForLaunch() {
  const pathEnv = STUB_DIR
    ? `${STUB_DIR}${path.delimiter}${process.env.PATH ?? ''}`
    : process.env.PATH ?? '';
  return {
    ...process.env,
    NODE_ENV: 'test',
    TZ: 'UTC',
    INVOKER_DB_DIR: DB_DIR,
    INVOKER_IPC_SOCKET: IPC_SOCKET,
    INVOKER_REPO_CONFIG_PATH: CONFIG_PATH,
    INVOKER_E2E_MARKER_ROOT: MARKER_ROOT,
    INVOKER_E2E_ENABLE_COMPOSITOR: '1',
    INVOKER_ALLOW_DELETE_ALL: '1',
    ...(CLAUDE_MARKER
      ? { INVOKER_CLAUDE_COMMAND: CLAUDE_MARKER, INVOKER_CLAUDE_FIX_COMMAND: CLAUDE_MARKER }
      : {}),
    PATH: pathEnv,
  };
}

function buildPlan(index) {
  const tasks = [];
  for (let i = 0; i < TASKS_PER_WORKFLOW; i += 1) {
    tasks.push({
      id: `task-${index}-${i}`,
      description: `Seed task ${index}-${i}`,
      command: `echo seed-${index}-${i}`,
      ...(i === 0 ? {} : { dependencies: [`task-${index}-${i - 1}`] }),
    });
  }
  return {
    name: `Snapshot Repro Plan ${index}`,
    repoUrl: `file://${REMOTE_REPO}`,
    baseBranch: 'master',
    onFinish: 'none',
    tasks,
  };
}

async function withApp(extraEnv, body) {
  const app = await electron.launch({
    args: [...launchArgs(), MAIN_JS],
    env: { ...envForLaunch(), ...(extraEnv ?? {}) },
    timeout: STARTUP_TIMEOUT_MS,
  });
  try {
    return await body(app);
  } finally {
    await app.close();
  }
}

async function seedDatabase() {
  await withApp({}, async (app) => {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof window.invoker !== 'undefined',
      null,
      { timeout: STARTUP_TIMEOUT_MS },
    );
    await page.evaluate(async () => {
      await window.invoker.clear();
      await window.invoker.deleteAllWorkflows();
    });
    for (let idx = 0; idx < WORKFLOW_COUNT; idx += 1) {
      const planYaml = yaml.stringify(buildPlan(idx));
      await page.evaluate((p) => window.invoker.loadPlan(p), planYaml);
    }
    const summary = await page.evaluate(async () => {
      const result = await window.invoker.getTasks(true);
      const tasks = Array.isArray(result) ? result : result.tasks;
      const workflows = Array.isArray(result) ? [] : result.workflows ?? [];
      return { tasks: tasks.length, workflows: workflows.length };
    });
    if (
      summary.workflows < WORKFLOW_COUNT
      || summary.tasks < WORKFLOW_COUNT * TASKS_PER_WORKFLOW
    ) {
      throw new Error(
        `seed: expected ${WORKFLOW_COUNT} workflows × ${TASKS_PER_WORKFLOW} tasks, `
        + `got workflows=${summary.workflows} tasks=${summary.tasks}`,
      );
    }
  });
}

async function captureStartup() {
  const startedAt = Date.now();
  return withApp({}, async (app) => {
    const page = await app.firstWindow({ timeout: STARTUP_TIMEOUT_MS });
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(
      () => typeof window.invoker !== 'undefined',
      null,
      { timeout: STARTUP_TIMEOUT_MS },
    );
    await page
      .locator('[data-testid^="workflow-node-"]')
      .first()
      .waitFor({ state: 'visible', timeout: STARTUP_TIMEOUT_MS });
    const graphVisibleAt = Date.now();
    await page.waitForTimeout(WAIT_AFTER_GRAPH_MS);
    const activityLogs = await page.evaluate(() => window.invoker.getActivityLogs());
    return {
      activityLogs,
      launchElapsedMs: Date.now() - startedAt,
      graphVisibleElapsedMs: graphVisibleAt - startedAt,
    };
  });
}

function parsePayload(entry) {
  try {
    return JSON.parse(entry.message);
  } catch {
    return null;
  }
}

(async () => {
  await seedDatabase();
  const { activityLogs, launchElapsedMs, graphVisibleElapsedMs } = await captureStartup();

  const uiPerf = activityLogs
    .filter((e) => e.source === 'ui-perf' || e.source === 'ui-perf-main')
    .map((e) => ({ id: e.id, source: e.source, payload: parsePayload(e) }))
    .filter((e) => e.payload && typeof e.payload === 'object');

  const bootstrap = uiPerf.find((e) => e.payload.metric === 'preload_bootstrap_sync');
  const bootstrapId = bootstrap ? bootstrap.id : 0;
  const replaces = uiPerf.filter((e) => e.payload.metric === 'useTasks_snapshot_replace');
  const postBootstrapReplaces = replaces.filter((e) => e.id > bootstrapId);
  const nonForcedReplace = postBootstrapReplaces.find((e) => e.payload.forceRefresh === false);
  const firstReplace = postBootstrapReplaces[0]?.payload ?? replaces[0]?.payload ?? null;
  const graphVisible = uiPerf.find((e) => e.payload.metric === 'startup_workflow_graph_visible');
  const taskGraphVisible = uiPerf.find((e) => e.payload.metric === 'startup_graph_visible');

  console.log('repro-startup-snapshot-refresh-overhead:');
  console.log(`  config:`);
  console.log(`    workflowCount_seed: ${WORKFLOW_COUNT}`);
  console.log(`    tasksPerWorkflow_seed: ${TASKS_PER_WORKFLOW}`);
  console.log(`    waitAfterGraphMs: ${WAIT_AFTER_GRAPH_MS}`);
  console.log(`  timing:`);
  console.log(`    launchElapsedMs: ${launchElapsedMs}`);
  console.log(`    graphVisibleElapsedMs: ${graphVisibleElapsedMs}`);

  if (bootstrap) {
    console.log('  preload_bootstrap_sync:');
    console.log(`    taskCount: ${bootstrap.payload.taskCount}`);
    console.log(`    workflowCount: ${bootstrap.payload.workflowCount}`);
    console.log(`    jsonSizeBytes: ${bootstrap.payload.jsonSizeBytes}`);
    console.log(`    durationMs: ${bootstrap.payload.durationMs}`);
    console.log(`    processElapsedMs: ${bootstrap.payload.processElapsedMs}`);
  } else {
    console.log('  preload_bootstrap_sync: MISSING');
  }

  console.log(`  post_bootstrap_replace_count: ${postBootstrapReplaces.length}`);
  if (firstReplace) {
    console.log('  useTasks_snapshot_replace (first post-bootstrap):');
    console.log(`    taskCount: ${firstReplace.taskCount}`);
    console.log(`    workflowCount: ${firstReplace.workflowCount}`);
    console.log(`    forceRefresh: ${firstReplace.forceRefresh}`);
    console.log(`    requestDurationMs: ${firstReplace.requestDurationMs}`);
    console.log(`    replaceDurationMs: ${firstReplace.replaceDurationMs}`);
    console.log(`    jsonSizeBytes: ${firstReplace.jsonSizeBytes}`);
  } else {
    console.log('  useTasks_snapshot_replace: NONE (no replace fired after bootstrap)');
  }

  if (graphVisible) {
    console.log('  startup_workflow_graph_visible:');
    console.log(`    nodeCount: ${graphVisible.payload.nodeCount}`);
    console.log(`    edgeCount: ${graphVisible.payload.edgeCount}`);
    console.log(`    elapsedMs: ${graphVisible.payload.elapsedMs}`);
    console.log(`    processElapsedMs: ${graphVisible.payload.processElapsedMs}`);
  } else {
    console.log('  startup_workflow_graph_visible: MISSING');
  }
  if (taskGraphVisible) {
    console.log('  startup_graph_visible (selected workflow):');
    console.log(`    nodeCount: ${taskGraphVisible.payload.nodeCount}`);
    console.log(`    elapsedMs: ${taskGraphVisible.payload.elapsedMs}`);
  }

  console.log(`  redundant_non_forced_replace: ${nonForcedReplace ? 'YES' : 'NO'}`);

  if (!bootstrap) {
    console.error('repro: ERROR — preload_bootstrap_sync was not recorded; cannot judge ordering.');
    process.exit(2);
  }
  if (!graphVisible) {
    console.error('repro: ERROR — startup_workflow_graph_visible was not recorded; graph never rendered.');
    process.exit(2);
  }

  if (EXPECT_ISSUE) {
    if (!nonForcedReplace) {
      console.error(
        'repro: FAIL — --expect-issue set, but no non-forced useTasks_snapshot_replace '
        + 'was observed after preload_bootstrap_sync. The redundancy may already be fixed; '
        + 'rerun without --expect-issue.',
      );
      process.exit(1);
    }
    console.log(
      'repro: PASS — observed redundant non-forced useTasks_snapshot_replace after '
      + 'preload_bootstrap_sync (current baseline reproduced).',
    );
    process.exit(0);
  }

  if (nonForcedReplace) {
    console.error(
      'repro: FAIL — non-forced useTasks_snapshot_replace fired after preload_bootstrap_sync; '
      + 'the redundant startup snapshot is still present.',
    );
    process.exit(1);
  }
  console.log(
    'repro: PASS — no redundant non-forced startup snapshot after preload_bootstrap_sync.',
  );
  process.exit(0);
})().catch((err) => {
  console.error('repro: ERROR —', err && err.stack ? err.stack : err);
  process.exit(2);
});
NODE_EOF

export INVOKER_REPO_ROOT="$ROOT_DIR"
export INVOKER_DB_DIR="$DB_DIR"
export INVOKER_IPC_SOCKET="$IPC_SOCKET"
export INVOKER_E2E_MARKER_ROOT="$MARKER_ROOT"
export INVOKER_REPO_CONFIG_PATH="$CONFIG_PATH"
export INVOKER_REMOTE_REPO="$REMOTE_REPO"
export INVOKER_STUB_DIR="$STUB_DIR"
export INVOKER_CLAUDE_MARKER="$CLAUDE_MARKER"
export WORKFLOW_COUNT TASKS_PER_WORKFLOW WAIT_AFTER_GRAPH_MS STARTUP_TIMEOUT_MS
export EXPECT_ISSUE
export HOME="$HOME_DIR"

if [[ -z "${DISPLAY:-}" ]]; then
  if ! command -v xvfb-run >/dev/null 2>&1; then
    echo "repro: ERROR — GUI capture needs DISPLAY or xvfb-run." >&2
    exit 2
  fi
  exec xvfb-run --auto-servernum --server-args='-screen 0 1280x800x24' \
    node --enable-source-maps "$DRIVER_JS"
fi

exec node --enable-source-maps "$DRIVER_JS"

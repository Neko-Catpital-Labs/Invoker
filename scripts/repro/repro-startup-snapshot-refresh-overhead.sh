#!/usr/bin/env bash
# Deterministic repro for the redundant post-bootstrap startup snapshot request.
#
# Background
# ----------
# Every Invoker window mounts the React `useTasks()` hook, which fires
# `window.invoker.getTasks(false)` from an effect. That IPC call returns the
# full {tasks, workflows} snapshot and triggers a `useTasks_snapshot_replace`
# (`forceRefresh=false`) ui-perf entry — even though the renderer already
# received the same snapshot synchronously from `preload_bootstrap_sync`
# before the React tree mounted. The redundant fetch is observed in
# production traces (~65-164ms / ~377KB) and lands AFTER the graph is
# already painted, so it is pure overhead.
#
# This script provisions an isolated INVOKER_DB_DIR with multiple
# workflows × tasks, restarts the Electron app against it, waits for the
# graph to be visible, then reads the `activity_log` ui-perf entries via
# `window.invoker.getActivityLogs()` and asserts on the sequence:
#
#   preload_bootstrap_sync   →   useTasks_snapshot_replace (forceRefresh=false)
#
# Exit codes
# ----------
#   With --expect-issue (default behaviour on the unfixed baseline):
#     0 — the redundant non-forced snapshot WAS observed (bug present).
#     1 — the redundant snapshot was NOT observed (bug appears fixed; either
#         the optimization landed or the repro setup is wrong).
#
#   Without --expect-issue (expected after the optimization lands):
#     0 — no redundant non-forced startup snapshot was observed.
#     1 — the redundant snapshot is still present (regression).
#
#   2 — setup / infrastructure failure (build missing, electron missing, etc.).
#
# Environment overrides
# ---------------------
#   INVOKER_REPRO_WORKFLOWS    workflows to seed (default 8)
#   INVOKER_REPRO_TASKS        tasks per workflow (default 8)
#   INVOKER_REPRO_KEEP_TMP=1   keep the temp INVOKER_DB_DIR for inspection
#   INVOKER_REPRO_VERBOSE=1    pass-through Playwright debug logs to stderr
#
# This script must remain rerunnable by CI or another agent. It must not
# touch the user's real `~/.invoker` directory or any shared SQLite DB.

set -euo pipefail

# ─── Argument parsing ────────────────────────────────────────────
EXPECT_ISSUE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    -h|--help)
      sed -n '2,46p' "$0"
      exit 0 ;;
    *)
      echo "[repro] unknown argument: $1" >&2
      echo "[repro] usage: $0 [--expect-issue]" >&2
      exit 2 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
APP_DIR="$REPO_ROOT/packages/app"
APP_MAIN_JS="$APP_DIR/dist/main.js"
UI_INDEX="$REPO_ROOT/packages/ui/dist/index.html"

die() { echo "[repro] FATAL: $*" >&2; exit 2; }

# ─── Pre-flight ──────────────────────────────────────────────────
command -v node    >/dev/null || die "node not found on PATH"
command -v python3 >/dev/null || die "python3 not found on PATH (used to parse helper output)"
command -v git     >/dev/null || die "git not found on PATH"

[[ -f "$APP_MAIN_JS" ]] || die "missing $APP_MAIN_JS (run 'pnpm -C $APP_DIR build')"
[[ -f "$UI_INDEX"    ]] || die "missing $UI_INDEX (run 'pnpm -C $REPO_ROOT/packages/ui build')"

# Playwright + Electron must be resolvable from packages/app.
node -e "require.resolve('@playwright/test', { paths: ['$APP_DIR'] })" 2>/dev/null \
  || die "@playwright/test not installed under packages/app/node_modules (run 'pnpm install')"
node -e "require.resolve('electron',         { paths: ['$APP_DIR'] })" 2>/dev/null \
  || die "electron not installed under packages/app/node_modules (run 'pnpm install')"

WORKFLOW_COUNT="${INVOKER_REPRO_WORKFLOWS:-8}"
TASKS_PER_WORKFLOW="${INVOKER_REPRO_TASKS:-8}"

STAMP="$(date +%s)-$$"
TEST_DIR="${TMPDIR:-/tmp}/invoker-repro-startup-snapshot-$STAMP"
BARE_REPO="$TEST_DIR/fixture-bare-repo.git"
HELPER_JS="$TEST_DIR/helper.mjs"
RESULT_JSON="$TEST_DIR/result.json"
HELPER_LOG="$TEST_DIR/helper.log"

mkdir -p "$TEST_DIR"

cleanup() {
  if [[ "${INVOKER_REPRO_KEEP_TMP:-0}" = "1" ]]; then
    echo "[repro] KEEP_TMP=1; leaving $TEST_DIR for inspection" >&2
    return
  fi
  rm -rf "$TEST_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ─── Provision a local bare repo for the seeded plans ────────────
# loadPlan requires a non-empty repoUrl. The fixture never executes a task,
# so we only need a clonable bare repo — no remote network access.
git init -q --bare "$BARE_REPO"
CLONE_TMP="$TEST_DIR/init-clone"
GIT_AUTHOR_NAME='Invoker Repro' GIT_AUTHOR_EMAIL='repro@invoker.local' \
GIT_COMMITTER_NAME='Invoker Repro' GIT_COMMITTER_EMAIL='repro@invoker.local' \
  git clone -q "$BARE_REPO" "$CLONE_TMP"
( cd "$CLONE_TMP" \
  && git -c user.email=repro@invoker.local -c user.name='Invoker Repro' commit -q --allow-empty -m init \
  && git push -q origin HEAD:refs/heads/master \
  && git push -q origin HEAD:refs/heads/main )
rm -rf "$CLONE_TMP"

REPO_URL="file://$BARE_REPO"

# ─── Write the Playwright helper ─────────────────────────────────
cat > "$HELPER_JS" <<'NODEJS'
// Drives Electron twice against the same INVOKER_DB_DIR:
//   1. Seed N workflows × M tasks via window.invoker.loadPlan(yaml).
//   2. Restart, wait for the workflow graph to be visible, then read all
//      ui-perf activity_log entries and emit a structured JSON summary.
//
// All knobs come from env vars; the script never writes outside
// INVOKER_REPRO_TEST_DIR.
import { _electron as electron } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';
import { writeFileSync, symlinkSync, mkdirSync } from 'node:fs';
import * as path from 'node:path';

const TEST_DIR = process.env.INVOKER_REPRO_TEST_DIR;
const RESULT_PATH = process.env.INVOKER_REPRO_RESULT_PATH;
const APP_MAIN = process.env.INVOKER_REPRO_APP_MAIN;
const REPO_URL = process.env.INVOKER_REPRO_REPO_URL;
const WORKFLOW_COUNT = Number(process.env.INVOKER_REPRO_WORKFLOW_COUNT);
const TASKS_PER_WORKFLOW = Number(process.env.INVOKER_REPRO_TASKS_PER_WORKFLOW);

if (!TEST_DIR || !RESULT_PATH || !APP_MAIN || !REPO_URL
    || !Number.isFinite(WORKFLOW_COUNT) || !Number.isFinite(TASKS_PER_WORKFLOW)) {
  throw new Error('helper.mjs: missing required INVOKER_REPRO_* environment variables');
}

const launchArgs = () => [
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
       '--disable-gpu-compositing', '--disable-gpu-sandbox',
       '--disable-software-rasterizer']
    : []),
  APP_MAIN,
];

const configPath = path.join(TEST_DIR, 'e2e-config.json');
writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

// Stub `claude` on PATH so any incidental command resolution does not hit a
// real CLI. The fixture never executes a task, but be defensive.
const stubDir = path.join(TEST_DIR, 'claude-stub');
mkdirSync(stubDir, { recursive: true });
const claudeStub = path.join(stubDir, 'claude');
try {
  writeFileSync(claudeStub, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
} catch {
  // best effort
}

const baseEnv = {
  ...process.env,
  NODE_ENV: 'test',
  TZ: 'UTC',
  INVOKER_DB_DIR: TEST_DIR,
  INVOKER_ALLOW_DELETE_ALL: '1',
  INVOKER_E2E_ENABLE_COMPOSITOR: '1',
  INVOKER_REPO_CONFIG_PATH: configPath,
  INVOKER_TEST_FIXED_NOW: '2025-01-01T00:00:00.000Z',
  INVOKER_CLAUDE_COMMAND: claudeStub,
  INVOKER_CLAUDE_FIX_COMMAND: claudeStub,
  PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
};

function buildPlan(index) {
  return {
    name: `Repro Startup Plan ${index}`,
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

async function waitForInvoker(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 15_000 });
}

// ─── Phase 1: seed ───────────────────────────────────────────────
process.stderr.write(`[helper] phase 1: seeding ${WORKFLOW_COUNT} workflows × ${TASKS_PER_WORKFLOW} tasks\n`);
const seedApp = await electron.launch({ args: launchArgs(), env: baseEnv });
try {
  const page = await seedApp.firstWindow({ timeout: 30_000 });
  await waitForInvoker(page);
  for (let i = 0; i < WORKFLOW_COUNT; i += 1) {
    const planYaml = yamlStringify(buildPlan(i));
    await page.evaluate(async (text) => { await window.invoker.loadPlan(text); }, planYaml);
  }
  const seeded = await page.evaluate(() => window.invoker.getTasks(true));
  const seededTasks = Array.isArray(seeded) ? seeded : seeded.tasks;
  process.stderr.write(`[helper] phase 1: seeded ${seededTasks.length} tasks\n`);
} finally {
  await seedApp.close();
}

// ─── Phase 2: observe ────────────────────────────────────────────
process.stderr.write('[helper] phase 2: relaunch & observe\n');
const app = await electron.launch({ args: launchArgs(), env: baseEnv });
let activityLogs;
try {
  const page = await app.firstWindow({ timeout: 30_000 });
  await waitForInvoker(page);
  await page.locator('[data-testid^="workflow-node-"]').first().waitFor({
    state: 'visible',
    timeout: 30_000,
  });
  // Give the post-mount snapshot fetch up to 5s to land in activity_log.
  // The bug is the snapshot replace landing AFTER the graph is visible.
  await page.waitForFunction(() => {
    return window.invoker.getActivityLogs().then((logs) => {
      const ui = logs.filter((e) => e.source === 'ui-perf');
      const bootstrap = ui.find((e) => {
        try { return JSON.parse(e.message).metric === 'preload_bootstrap_sync'; }
        catch { return false; }
      });
      if (!bootstrap) return false;
      const replace = ui.find((e) => {
        if (e.id <= bootstrap.id) return false;
        try {
          const p = JSON.parse(e.message);
          return p.metric === 'useTasks_snapshot_replace';
        } catch { return false; }
      });
      return Boolean(replace);
    });
  }, null, { timeout: 5_000 }).catch(() => undefined);
  activityLogs = await page.evaluate(() => window.invoker.getActivityLogs());
} finally {
  await app.close();
}

// ─── Parse activity logs ─────────────────────────────────────────
const uiPerf = activityLogs
  .filter((entry) => entry.source === 'ui-perf')
  .map((entry) => {
    try { return { id: entry.id, payload: JSON.parse(entry.message) }; }
    catch { return null; }
  })
  .filter(Boolean);

const findByMetric = (metric) => uiPerf.find((e) => e.payload.metric === metric);
const bootstrap = findByMetric('preload_bootstrap_sync');
const allReplaces = uiPerf.filter((e) => e.payload.metric === 'useTasks_snapshot_replace');
const postBootstrapReplaces = bootstrap
  ? allReplaces.filter((e) => e.id > bootstrap.id)
  : allReplaces;
const nonForcedAfterBootstrap = postBootstrapReplaces.find((e) => e.payload.forceRefresh === false);
const workflowGraphVisible = findByMetric('startup_workflow_graph_visible');
const taskGraphVisible = findByMetric('startup_graph_visible');
const startupSnapshotApplied = findByMetric('startup_snapshot_applied');

const summary = {
  workflowCountSeeded: WORKFLOW_COUNT,
  tasksPerWorkflowSeeded: TASKS_PER_WORKFLOW,
  bootstrap: bootstrap
    ? {
        taskCount: bootstrap.payload.taskCount,
        workflowCount: bootstrap.payload.workflowCount,
        jsonSizeBytes: bootstrap.payload.jsonSizeBytes,
        durationMs: bootstrap.payload.durationMs,
        processElapsedMs: bootstrap.payload.processElapsedMs,
      }
    : null,
  postBootstrapReplaceCount: postBootstrapReplaces.length,
  postBootstrapForcedCount: postBootstrapReplaces.filter((e) => e.payload.forceRefresh === true).length,
  postBootstrapNonForcedCount: postBootstrapReplaces.filter((e) => e.payload.forceRefresh === false).length,
  nonForcedAfterBootstrap: nonForcedAfterBootstrap
    ? {
        forceRefresh: nonForcedAfterBootstrap.payload.forceRefresh,
        taskCount: nonForcedAfterBootstrap.payload.taskCount,
        workflowCount: nonForcedAfterBootstrap.payload.workflowCount,
        jsonSizeBytes: nonForcedAfterBootstrap.payload.jsonSizeBytes,
        requestDurationMs: nonForcedAfterBootstrap.payload.requestDurationMs,
        replaceDurationMs: nonForcedAfterBootstrap.payload.replaceDurationMs,
      }
    : null,
  graphVisible: workflowGraphVisible
    ? {
        metric: 'startup_workflow_graph_visible',
        nodeCount: workflowGraphVisible.payload.nodeCount,
        edgeCount: workflowGraphVisible.payload.edgeCount,
        elapsedMs: workflowGraphVisible.payload.elapsedMs,
        processElapsedMs: workflowGraphVisible.payload.processElapsedMs,
      }
    : null,
  taskGraphVisible: taskGraphVisible
    ? {
        metric: 'startup_graph_visible',
        nodeCount: taskGraphVisible.payload.nodeCount,
        edgeCount: taskGraphVisible.payload.edgeCount,
        elapsedMs: taskGraphVisible.payload.elapsedMs,
        processElapsedMs: taskGraphVisible.payload.processElapsedMs,
      }
    : null,
  startupSnapshotApplied: startupSnapshotApplied
    ? {
        forceRefresh: startupSnapshotApplied.payload.forceRefresh,
        taskCount: startupSnapshotApplied.payload.taskCount,
        workflowCount: startupSnapshotApplied.payload.workflowCount,
        elapsedMs: startupSnapshotApplied.payload.elapsedMs,
        processElapsedMs: startupSnapshotApplied.payload.processElapsedMs,
      }
    : null,
};

writeFileSync(RESULT_PATH, JSON.stringify(summary, null, 2));
process.stderr.write('[helper] done\n');
NODEJS

# ─── Run the helper ──────────────────────────────────────────────
HELPER_EXIT=0
(
  cd "$APP_DIR"
  INVOKER_REPRO_TEST_DIR="$TEST_DIR" \
  INVOKER_REPRO_RESULT_PATH="$RESULT_JSON" \
  INVOKER_REPRO_APP_MAIN="$APP_MAIN_JS" \
  INVOKER_REPRO_REPO_URL="$REPO_URL" \
  INVOKER_REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  INVOKER_REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
    node "$HELPER_JS"
) >"$HELPER_LOG" 2>&1 || HELPER_EXIT=$?

if [[ "${INVOKER_REPRO_VERBOSE:-0}" = "1" ]]; then
  cat "$HELPER_LOG" >&2
fi

if [[ $HELPER_EXIT -ne 0 ]]; then
  echo "[repro] helper script failed (exit=$HELPER_EXIT). Tail of helper log:" >&2
  tail -n 80 "$HELPER_LOG" >&2 || true
  exit 2
fi

if [[ ! -s "$RESULT_JSON" ]]; then
  echo "[repro] helper produced no result file at $RESULT_JSON" >&2
  tail -n 80 "$HELPER_LOG" >&2 || true
  exit 2
fi

# ─── Report and assert ───────────────────────────────────────────
python3 - "$RESULT_JSON" "$EXPECT_ISSUE" <<'PY'
import json
import sys

result_path = sys.argv[1]
expect_issue = sys.argv[2] == '1'

with open(result_path, 'r', encoding='utf-8') as fh:
    summary = json.load(fh)

def fmt(value, suffix=''):
    if value is None:
        return '(missing)'
    if isinstance(value, float):
        return f'{value:.2f}{suffix}'
    return f'{value}{suffix}'

print('=' * 78)
print('[repro] Startup snapshot refresh overhead — observations')
print('=' * 78)
print(f"  seeded:                       {summary['workflowCountSeeded']} workflows × "
      f"{summary['tasksPerWorkflowSeeded']} tasks")

bootstrap = summary.get('bootstrap')
if bootstrap is None:
    print('  preload_bootstrap_sync:       (missing — repro likely broken)')
else:
    print(f"  preload_bootstrap_sync:")
    print(f"    taskCount                 = {fmt(bootstrap.get('taskCount'))}")
    print(f"    workflowCount             = {fmt(bootstrap.get('workflowCount'))}")
    print(f"    jsonSizeBytes             = {fmt(bootstrap.get('jsonSizeBytes'))}")
    print(f"    durationMs                = {fmt(bootstrap.get('durationMs'), 'ms')}")
    print(f"    processElapsedMs          = {fmt(bootstrap.get('processElapsedMs'), 'ms')}")

graph = summary.get('graphVisible')
if graph is not None:
    print(f"  startup_workflow_graph_visible:")
    print(f"    nodeCount                 = {fmt(graph.get('nodeCount'))}")
    print(f"    edgeCount                 = {fmt(graph.get('edgeCount'))}")
    print(f"    elapsedMs                 = {fmt(graph.get('elapsedMs'), 'ms')}")
    print(f"    processElapsedMs          = {fmt(graph.get('processElapsedMs'), 'ms')}")
else:
    print('  startup_workflow_graph_visible: (missing)')

task_graph = summary.get('taskGraphVisible')
if task_graph is not None:
    print(f"  startup_graph_visible (task DAG):")
    print(f"    nodeCount                 = {fmt(task_graph.get('nodeCount'))}")
    print(f"    edgeCount                 = {fmt(task_graph.get('edgeCount'))}")
    print(f"    elapsedMs                 = {fmt(task_graph.get('elapsedMs'), 'ms')}")
    print(f"    processElapsedMs          = {fmt(task_graph.get('processElapsedMs'), 'ms')}")

print(f"  post-bootstrap useTasks_snapshot_replace events:")
print(f"    total                       = {summary['postBootstrapReplaceCount']}")
print(f"    non-forced (the bug)        = {summary['postBootstrapNonForcedCount']}")
print(f"    forced (explicit refresh)   = {summary['postBootstrapForcedCount']}")

non_forced = summary.get('nonForcedAfterBootstrap')
if non_forced is not None:
    print(f"  first non-forced replace after preload_bootstrap_sync:")
    print(f"    forceRefresh              = {fmt(non_forced.get('forceRefresh'))}")
    print(f"    taskCount                 = {fmt(non_forced.get('taskCount'))}")
    print(f"    workflowCount             = {fmt(non_forced.get('workflowCount'))}")
    print(f"    jsonSizeBytes             = {fmt(non_forced.get('jsonSizeBytes'))}")
    print(f"    requestDurationMs         = {fmt(non_forced.get('requestDurationMs'), 'ms')}")
    print(f"    replaceDurationMs         = {fmt(non_forced.get('replaceDurationMs'), 'ms')}")
else:
    print('  first non-forced replace after preload_bootstrap_sync: (none observed)')

snapshot_applied = summary.get('startupSnapshotApplied')
if snapshot_applied is not None:
    print(f"  startup_snapshot_applied (one-shot):")
    print(f"    forceRefresh              = {fmt(snapshot_applied.get('forceRefresh'))}")
    print(f"    taskCount                 = {fmt(snapshot_applied.get('taskCount'))}")
    print(f"    workflowCount             = {fmt(snapshot_applied.get('workflowCount'))}")
    print(f"    processElapsedMs          = {fmt(snapshot_applied.get('processElapsedMs'), 'ms')}")

print('=' * 78)

observed_bug = non_forced is not None
if expect_issue:
    if observed_bug:
        print('[repro] PASS: redundant non-forced useTasks_snapshot_replace WAS observed after '
              'preload_bootstrap_sync (baseline reproduction confirmed).')
        sys.exit(0)
    else:
        print('[repro] FAIL: --expect-issue was set but no redundant non-forced snapshot was '
              'observed. Either the optimization already landed or the fixture is wrong.',
              file=sys.stderr)
        sys.exit(1)
else:
    if observed_bug:
        print('[repro] FAIL: redundant non-forced useTasks_snapshot_replace still fires after '
              'preload_bootstrap_sync. The optimization regressed (or has not landed yet).',
              file=sys.stderr)
        sys.exit(1)
    else:
        print('[repro] PASS: no redundant non-forced startup snapshot was observed.')
        sys.exit(0)
PY

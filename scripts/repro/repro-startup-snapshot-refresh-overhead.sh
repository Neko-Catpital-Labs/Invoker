#!/usr/bin/env bash
set -euo pipefail

# Repro: the renderer fires a redundant non-forced `useTasks_snapshot_replace`
# request after `preload_bootstrap_sync` has already populated the bootstrap
# state. The current baseline pays ~65-164ms and ~377KB transferring a snapshot
# that duplicates what preload just delivered.
#
# This script seeds an isolated INVOKER_DB_DIR with multiple workflows × tasks,
# relaunches the Electron app, captures the ui-perf events recorded into the
# `activity_log` table via `window.invoker.getActivityLogs()`, and reports the
# timing/size numbers needed to characterize the bug or its fix.
#
# Modes:
#   --expect-issue  Exit 0 when at least one non-forced startup
#                   `useTasks_snapshot_replace` event is observed after
#                   `preload_bootstrap_sync` (the current baseline bug).
#   (no flag)       Exit 0 only when no non-forced startup
#                   `useTasks_snapshot_replace` event fires after
#                   `preload_bootstrap_sync` (the post-optimization target).
#
# Environment overrides:
#   REPRO_WORKFLOW_COUNT       (default: 12)
#   REPRO_TASKS_PER_WORKFLOW   (default: 8)
#   REPRO_TIMEOUT_MS           (default: 30000)
#   REPRO_POST_VISIBLE_WAIT_MS (default: 2500)
#   REPRO_HEADFUL              when set to 1, skips xvfb-run

usage() {
  sed -n 's/^# \{0,1\}//p' "$0" | sed -n '/^Repro:/,/^Environment overrides:/p; /^  REPRO_/p' >&2
}

EXPECT_ISSUE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue) EXPECT_ISSUE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 1 ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-12}"
TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}"
TIMEOUT_MS="${REPRO_TIMEOUT_MS:-30000}"
POST_VISIBLE_WAIT_MS="${REPRO_POST_VISIBLE_WAIT_MS:-2500}"

if ! command -v node >/dev/null 2>&1; then
  echo "repro: node is required but not on PATH" >&2
  exit 1
fi
if ! command -v git >/dev/null 2>&1; then
  echo "repro: git is required but not on PATH" >&2
  exit 1
fi

need_build=0
[[ -f packages/surfaces/dist/index.js ]] || need_build=1
[[ -f packages/ui/dist/index.html ]] || need_build=1
[[ -f packages/app/dist/main.js ]] || need_build=1
if (( need_build )); then
  echo "repro: building required packages (surfaces, ui, app)..."
  pnpm --filter @invoker/surfaces build >/dev/null
  pnpm --filter @invoker/ui build >/dev/null
  pnpm --filter @invoker/app build >/dev/null
fi

if [[ ! -d packages/app/node_modules/@playwright/test ]]; then
  echo "repro: @playwright/test is not installed under packages/app/node_modules." >&2
  echo "       Run 'pnpm install --filter @invoker/app' before invoking this script." >&2
  exit 1
fi

# Stage the JS driver inside packages/app/node_modules so Node resolves
# @playwright/test and yaml naturally (packages/app is the only workspace that
# depends on @playwright/test). node_modules/ is gitignored.
DRIVER_DIR="$REPO_ROOT/packages/app/node_modules/.cache/invoker-repro"
mkdir -p "$DRIVER_DIR"
DRIVER="$DRIVER_DIR/startup-snapshot-driver.mjs"

cat > "$DRIVER" <<'JS'
import { _electron as electron } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { writeFileSync, mkdirSync } from 'node:fs';

const repoRoot = process.env.REPRO_REPO_ROOT;
const testDir = process.env.REPRO_TEST_DIR;
const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT);
const tasksPerWorkflow = Number(process.env.REPRO_TASKS_PER_WORKFLOW);
const timeoutMs = Number(process.env.REPRO_TIMEOUT_MS);
const postVisibleWaitMs = Number(process.env.REPRO_POST_VISIBLE_WAIT_MS);
const expectIssue = process.env.REPRO_EXPECT_ISSUE === '1';

const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const stubDir = path.join(testDir, 'claude-stub');
const markerRoot = path.join(testDir, 'e2e-markers');
const configPath = path.join(testDir, 'config.json');
const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
const dbDir = path.join(testDir, 'db');
const bareRepo = path.join(testDir, 'remote.git');

mkdirSync(stubDir, { recursive: true });
mkdirSync(markerRoot, { recursive: true });
mkdirSync(dbDir, { recursive: true });
writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
try { await fs.symlink(claudeMarker, path.join(stubDir, 'claude')); } catch {}

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Invoker Repro',
  GIT_AUTHOR_EMAIL: 'repro@invoker.dev',
  GIT_COMMITTER_NAME: 'Invoker Repro',
  GIT_COMMITTER_EMAIL: 'repro@invoker.dev',
};
execSync(`git init --bare "${bareRepo}"`, { stdio: 'ignore' });
const tmpClone = `${bareRepo}.setup`;
execSync(`git clone "${bareRepo}" "${tmpClone}"`, { stdio: 'ignore', env: gitEnv });
execSync('git commit --allow-empty -m init', { cwd: tmpClone, stdio: 'ignore', env: gitEnv });
execSync('git push origin HEAD:refs/heads/master', { cwd: tmpClone, stdio: 'ignore', env: gitEnv });
execSync('git push origin HEAD:refs/heads/main', { cwd: tmpClone, stdio: 'ignore', env: gitEnv });
await fs.rm(tmpClone, { recursive: true, force: true });
const repoUrl = pathToFileURL(bareRepo).href;

const electronArgs = [
  ...(process.platform === 'linux'
    ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
    : []),
  path.resolve(repoRoot, 'packages', 'app', 'dist', 'main.js'),
];
const electronEnv = {
  ...process.env,
  NODE_ENV: 'test',
  INVOKER_DB_DIR: dbDir,
  INVOKER_IPC_SOCKET: ipcSocketPath,
  INVOKER_ALLOW_DELETE_ALL: '1',
  INVOKER_E2E_ENABLE_COMPOSITOR: '1',
  INVOKER_REPO_CONFIG_PATH: configPath,
  INVOKER_E2E_MARKER_ROOT: markerRoot,
  INVOKER_CLAUDE_COMMAND: claudeMarker,
  INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
  PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
};

function buildPlan(index) {
  return {
    name: `Repro Startup Plan ${index}`,
    repoUrl,
    onFinish: 'none',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, j) => ({
      id: `task-${index}-${j}`,
      description: `Task ${index}-${j}`,
      command: `echo task-${index}-${j}`,
      dependencies: j === 0 ? [] : [`task-${index}-${j - 1}`],
    })),
  };
}

// 1) Seed N workflows × M tasks into an isolated DB.
const seedApp = await electron.launch({ args: electronArgs, env: electronEnv });
try {
  const page = await seedApp.firstWindow({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: timeoutMs });
  for (let i = 0; i < workflowCount; i++) {
    const planYaml = yamlStringify(buildPlan(i));
    await page.evaluate((text) => window.invoker.loadPlan(text), planYaml);
  }
  const seedSize = await page.evaluate(async () => {
    const r = await window.invoker.getTasks(true);
    return Array.isArray(r) ? r.length : r.tasks.length;
  });
  const expected = workflowCount * tasksPerWorkflow;
  if (seedSize !== expected) {
    throw new Error(`seed expected ${expected} tasks but got ${seedSize}`);
  }
} finally {
  await seedApp.close();
}

// 2) Relaunch and capture startup ui-perf events.
const app = await electron.launch({ args: electronArgs, env: electronEnv });
let exitCode = 1;
try {
  const page = await app.firstWindow({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: timeoutMs });
  await page
    .locator('[data-testid^="workflow-node-"]')
    .first()
    .waitFor({ state: 'visible', timeout: timeoutMs });
  // Give post-mount fetchAll() time to run and `useTasks_snapshot_replace`
  // time to land in activity_log before we query.
  await page.waitForTimeout(postVisibleWaitMs);
  const activityLogs = await page.evaluate(() => window.invoker.getActivityLogs());

  const parse = (msg) => { try { return JSON.parse(msg); } catch { return null; } };
  const uiPerf = (activityLogs ?? [])
    .filter((e) => e.source === 'ui-perf')
    .map((e) => ({ id: e.id, ts: e.timestamp, payload: parse(e.message) }))
    .filter((e) => e.payload);
  const indexOf = (target) => uiPerf.indexOf(target);
  const findByMetric = (m) => uiPerf.find((e) => e.payload.metric === m);
  const preload = findByMetric('preload_bootstrap_sync');
  const workflowGraphVisible = findByMetric('startup_workflow_graph_visible');
  const taskGraphVisible = findByMetric('startup_graph_visible');
  const snapshotReplaces = uiPerf.filter((e) => e.payload.metric === 'useTasks_snapshot_replace');
  const preloadIdx = preload ? indexOf(preload) : -1;
  const postPreloadReplaces = preloadIdx >= 0
    ? snapshotReplaces.filter((e) => indexOf(e) > preloadIdx)
    : snapshotReplaces;
  const nonForcedAfterPreload = postPreloadReplaces.filter(
    (e) => e.payload.forceRefresh === false,
  );
  const firstPostPreload = postPreloadReplaces[0]?.payload;
  const firstNonForced = nonForcedAfterPreload[0]?.payload;

  const round = (n) => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);

  console.log('repro-startup-snapshot-refresh-overhead:');
  if (preload) {
    console.log('  preload_bootstrap_sync:');
    console.log(`    taskCount=${preload.payload.taskCount}`);
    console.log(`    workflowCount=${preload.payload.workflowCount}`);
    console.log(`    jsonSizeBytes=${preload.payload.jsonSizeBytes}`);
    console.log(`    durationMs=${round(preload.payload.durationMs)}`);
  } else {
    console.log('  preload_bootstrap_sync: MISSING');
  }
  console.log('  startup_workflow_graph_visible:');
  if (workflowGraphVisible) {
    console.log(`    nodeCount=${workflowGraphVisible.payload.nodeCount}`);
    console.log(`    edgeCount=${workflowGraphVisible.payload.edgeCount}`);
    console.log(`    elapsedMs=${round(workflowGraphVisible.payload.elapsedMs)}`);
    console.log(`    processElapsedMs=${round(workflowGraphVisible.payload.processElapsedMs)}`);
  } else {
    console.log('    MISSING');
  }
  console.log('  startup_graph_visible (task DAG):');
  if (taskGraphVisible) {
    console.log(`    nodeCount=${taskGraphVisible.payload.nodeCount}`);
    console.log(`    elapsedMs=${round(taskGraphVisible.payload.elapsedMs)}`);
  } else {
    console.log('    MISSING (no workflow selected — task DAG not rendered)');
  }
  console.log(`  post-preload useTasks_snapshot_replace events: ${postPreloadReplaces.length}`);
  console.log(`    non-forced: ${nonForcedAfterPreload.length}`);
  if (firstPostPreload) {
    console.log('  first post-preload useTasks_snapshot_replace:');
    console.log(`    forceRefresh=${firstPostPreload.forceRefresh}`);
    console.log(`    taskCount=${firstPostPreload.taskCount}`);
    console.log(`    workflowCount=${firstPostPreload.workflowCount}`);
    console.log(`    jsonSizeBytes=${firstPostPreload.jsonSizeBytes}`);
    console.log(`    requestDurationMs=${round(firstPostPreload.requestDurationMs)}`);
    console.log(`    replaceDurationMs=${round(firstPostPreload.replaceDurationMs)}`);
  } else {
    console.log('  first post-preload useTasks_snapshot_replace: NONE');
  }
  if (firstNonForced && firstNonForced !== firstPostPreload) {
    console.log('  first non-forced post-preload useTasks_snapshot_replace:');
    console.log(`    forceRefresh=${firstNonForced.forceRefresh}`);
    console.log(`    taskCount=${firstNonForced.taskCount}`);
    console.log(`    workflowCount=${firstNonForced.workflowCount}`);
    console.log(`    jsonSizeBytes=${firstNonForced.jsonSizeBytes}`);
    console.log(`    requestDurationMs=${round(firstNonForced.requestDurationMs)}`);
    console.log(`    replaceDurationMs=${round(firstNonForced.replaceDurationMs)}`);
  }

  if (!preload || !workflowGraphVisible) {
    console.error('repro: required ui-perf events missing; cannot judge outcome');
    exitCode = 2;
  } else if (expectIssue) {
    if (nonForcedAfterPreload.length > 0) {
      console.log('repro: baseline reproduced (redundant non-forced startup snapshot observed)');
      exitCode = 0;
    } else {
      console.error('repro: expected redundant non-forced startup snapshot but found none');
      exitCode = 1;
    }
  } else if (nonForcedAfterPreload.length === 0) {
    console.log('repro: optimization holds (no redundant non-forced startup snapshot)');
    exitCode = 0;
  } else {
    console.error('repro: optimization regression — redundant non-forced startup snapshot still fires');
    exitCode = 1;
  }
} finally {
  await app.close();
}
process.exit(exitCode);
JS

TMP_DIR="$(mktemp -d -t invoker-startup-snapshot-XXXXXX)"
cleanup() {
  rm -rf "$TMP_DIR" 2>/dev/null || true
  rm -f "$DRIVER" 2>/dev/null || true
}
trap cleanup EXIT

export REPRO_REPO_ROOT="$REPO_ROOT"
export REPRO_TEST_DIR="$TMP_DIR"
export REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT"
export REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW"
export REPRO_TIMEOUT_MS="$TIMEOUT_MS"
export REPRO_POST_VISIBLE_WAIT_MS="$POST_VISIBLE_WAIT_MS"
export REPRO_EXPECT_ISSUE="$EXPECT_ISSUE"

run_node() {
  if [[ "${REPRO_HEADFUL:-0}" = "1" ]]; then
    node "$DRIVER"
  elif command -v xvfb-run >/dev/null 2>&1; then
    xvfb-run --auto-servernum node "$DRIVER"
  else
    echo "repro: xvfb-run not found; running Electron with --no-sandbox/--disable-gpu only" >&2
    node "$DRIVER"
  fi
}

set +e
run_node
status=$?
set -e
exit "$status"

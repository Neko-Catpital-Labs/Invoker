#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
Usage: bash scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]

Exits 0 with --expect-issue when it observes a non-forced
useTasks_snapshot_replace after preload_bootstrap_sync.

Without --expect-issue it exits 0 only when no redundant non-forced startup
snapshot replace is observed.

Environment overrides:
  REPRO_WORKFLOW_COUNT          Default: 12
  REPRO_TASKS_PER_WORKFLOW      Default: 8
  REPRO_TIMEOUT_MS              Default: 15000
  REPRO_POST_VISIBLE_WAIT_MS    Default: 1200
  REPRO_HEADFUL                 Default: 0
  REPRO_SKIP_BUILD              Default: 0
  REPRO_BUILD_TIMEOUT_SECONDS   Default: 300
EOF
}

EXPECT_ISSUE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expect-issue)
      EXPECT_ISSUE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

run_with_timeout() {
  local seconds="$1"
  shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$seconds" "$@"
    return $?
  fi
  "$@"
}

if [ "${REPRO_SKIP_BUILD:-0}" != "1" ]; then
  if [ ! -f packages/app/dist/main.js ] || [ ! -f packages/ui/dist/index.html ]; then
    echo "[repro] Building app and UI artifacts..."
    run_with_timeout "${REPRO_BUILD_TIMEOUT_SECONDS:-300}" pnpm --filter @invoker/ui build
    run_with_timeout "${REPRO_BUILD_TIMEOUT_SECONDS:-300}" pnpm --filter @invoker/app build
  fi
fi

if [ ! -f packages/app/dist/main.js ]; then
  echo "[repro] Missing packages/app/dist/main.js. Run: pnpm --filter @invoker/app build" >&2
  exit 2
fi
if [ ! -f packages/ui/dist/index.html ]; then
  echo "[repro] Missing packages/ui/dist/index.html. Run: pnpm --filter @invoker/ui build" >&2
  exit 2
fi

node scripts/electron.cjs --ensure-only

TMP_ROOT="$(mktemp -d -t invoker-startup-snapshot-repro.XXXXXX)"
cleanup() {
  rm -rf "$TMP_ROOT"
}
trap cleanup EXIT

WORK_REPO="$TMP_ROOT/repo"
BARE_REPO="$TMP_ROOT/repo.git"
mkdir -p "$WORK_REPO"
git -C "$WORK_REPO" init -q -b main
git -C "$WORK_REPO" config user.name repro
git -C "$WORK_REPO" config user.email repro@example.invalid
printf 'startup snapshot repro\n' > "$WORK_REPO/README.md"
git -C "$WORK_REPO" add README.md
git -C "$WORK_REPO" commit -q -m 'seed repro repo'
git -C "$WORK_REPO" clone --bare "$WORK_REPO" "$BARE_REPO" >/dev/null 2>&1

export REPRO_EXPECT_ISSUE="$EXPECT_ISSUE"
export REPRO_REPO_ROOT="$REPO_ROOT"
export REPRO_TMP_ROOT="$TMP_ROOT"
export REPRO_DB_DIR="$TMP_ROOT/db"
export REPRO_BARE_REPO="$BARE_REPO"
export REPRO_WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-12}"
export REPRO_TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}"
export REPRO_TIMEOUT_MS="${REPRO_TIMEOUT_MS:-15000}"
export REPRO_POST_VISIBLE_WAIT_MS="${REPRO_POST_VISIBLE_WAIT_MS:-1200}"
export REPRO_HEADFUL="${REPRO_HEADFUL:-0}"

run_node() {
  node <<'NODE'
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const yaml = require('yaml');

const repoRoot = process.env.REPRO_REPO_ROOT;
const appRequire = createRequire(path.join(repoRoot, 'packages', 'app', 'package.json'));
const { _electron: electron } = appRequire('@playwright/test');
const tmpRoot = process.env.REPRO_TMP_ROOT;
const dbDir = process.env.REPRO_DB_DIR;
const bareRepo = process.env.REPRO_BARE_REPO;
const workflowCount = Number.parseInt(process.env.REPRO_WORKFLOW_COUNT || '12', 10);
const tasksPerWorkflow = Number.parseInt(process.env.REPRO_TASKS_PER_WORKFLOW || '8', 10);
const timeoutMs = Number.parseInt(process.env.REPRO_TIMEOUT_MS || '15000', 10);
const postVisibleWaitMs = Number.parseInt(process.env.REPRO_POST_VISIBLE_WAIT_MS || '1200', 10);
const expectIssue = process.env.REPRO_EXPECT_ISSUE === '1';
const headful = process.env.REPRO_HEADFUL === '1';

const mainJs = path.join(repoRoot, 'packages', 'app', 'dist', 'main.js');
const claudeMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const codexMarker = path.join(repoRoot, 'scripts', 'e2e-dry-run', 'fixtures', 'codex-marker.sh');
const stubDir = path.join(tmpRoot, 'agent-stub');
const markerRoot = path.join(tmpRoot, 'markers');
const configPath = path.join(tmpRoot, 'config.json');

function mkdirp(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function linkOrCopy(source, dest) {
  try {
    fs.symlinkSync(source, dest);
  } catch {
    fs.copyFileSync(source, dest);
    fs.chmodSync(dest, 0o755);
  }
}

function buildPlan(index) {
  return {
    name: `Startup Snapshot Repro ${index}`,
    repoUrl: pathToFileURL(bareRepo).href,
    onFinish: 'none',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Startup snapshot repro task ${index}-${taskIndex}`,
      command: `echo startup-snapshot-repro-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function launchApp(extraEnv = {}) {
  const ipcSocketPath = path.join(tmpRoot, `ipc-${Date.now()}-${Math.random().toString(16).slice(2)}.sock`);
  const args = [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    mainJs,
  ];
  return electron.launch({
    args,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: 'UTC',
      INVOKER_DB_DIR: dbDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_E2E_MARKER_ROOT: markerRoot,
      INVOKER_TEST_FIXED_NOW: '2025-01-01T00:00:00.000Z',
      INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extraEnv,
    },
    timeout: timeoutMs,
  });
}

function parseUiPerf(entry) {
  if (entry.source !== 'ui-perf') return null;
  try {
    return { id: entry.id, timestamp: entry.timestamp, payload: JSON.parse(entry.message) };
  } catch {
    return null;
  }
}

function fmt(value) {
  return value === undefined || value === null ? 'n/a' : String(value);
}

async function firstWindow(app) {
  const page = await app.firstWindow({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: timeoutMs });
  return page;
}

async function seedFixture(page) {
  await page.evaluate(async () => {
    await window.invoker.clear();
    await window.invoker.deleteAllWorkflows();
  });
  for (let index = 0; index < workflowCount; index += 1) {
    await page.evaluate((planText) => window.invoker.loadPlan(planText), yaml.stringify(buildPlan(index)));
  }
  const seeded = await page.evaluate(async () => {
    const result = await window.invoker.getTasks(true);
    const tasks = Array.isArray(result) ? result : result.tasks;
    const workflows = Array.isArray(result) ? [] : result.workflows || [];
    return { taskCount: tasks.length, workflowCount: workflows.length };
  });
  const expectedTaskCount = workflowCount * (tasksPerWorkflow + 1);
  if (seeded.workflowCount !== workflowCount || seeded.taskCount !== expectedTaskCount) {
    throw new Error(
      `Seed count mismatch: got ${seeded.workflowCount} workflows / ${seeded.taskCount} tasks, ` +
      `expected ${workflowCount} workflows / ${expectedTaskCount} tasks`,
    );
  }
  console.log(`[repro] Seeded ${seeded.workflowCount} workflows / ${seeded.taskCount} tasks`);
}

async function collectStartupEvidence(page) {
  const startedAt = Date.now();
  const beforeReloadLastLogId = await page.evaluate(async () => {
    const logs = await window.invoker.getActivityLogs();
    return logs.reduce((max, entry) => Math.max(max, Number(entry.id) || 0), 0);
  });
  await page.reload({ waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: timeoutMs });

  const graphWaitStartedAt = Date.now();
  await page.locator('[data-testid^="workflow-node-"]').first().waitFor({ state: 'visible', timeout: timeoutMs });
  const graphVisibleWallMs = Date.now() - graphWaitStartedAt;
  await page.waitForTimeout(postVisibleWaitMs);
  const result = await page.evaluate(async () => {
    const activityLogs = await window.invoker.getActivityLogs();
    const tasksResult = await window.invoker.getTasks(true);
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    const workflows = Array.isArray(tasksResult) ? [] : tasksResult.workflows || [];
    return { activityLogs, taskCount: tasks.length, workflowCount: workflows.length };
  });

  const uiPerf = result.activityLogs
    .filter((entry) => Number(entry.id) > beforeReloadLastLogId)
    .map(parseUiPerf)
    .filter(Boolean);
  const bootstrap = uiPerf.find((entry) => entry.payload.metric === 'preload_bootstrap_sync');
  const graphVisible = uiPerf.find((entry) => entry.payload.metric === 'startup_workflow_graph_visible');
  const taskGraphVisible = uiPerf.find((entry) => entry.payload.metric === 'startup_graph_visible');
  const replacements = uiPerf.filter((entry) => entry.payload.metric === 'useTasks_snapshot_replace');
  const postBootstrapReplacements = bootstrap
    ? replacements.filter((entry) => entry.id > bootstrap.id)
    : replacements;
  const redundant = postBootstrapReplacements.find((entry) => entry.payload.forceRefresh !== true);

  if (!bootstrap || !graphVisible) {
    console.log(`[repro] ui-perf metrics seen: ${uiPerf.map((entry) => entry.payload.metric).join(', ')}`);
    throw Object.assign(new Error('Missing required startup ui-perf evidence'), { exitCode: 2 });
  }

  console.log('[repro] Startup evidence');
  console.log(`bootstrap taskCount=${fmt(bootstrap.payload.taskCount)} workflowCount=${fmt(bootstrap.payload.workflowCount)} jsonSizeBytes=${fmt(bootstrap.payload.jsonSizeBytes)} durationMs=${fmt(bootstrap.payload.durationMs)} processElapsedMs=${fmt(bootstrap.payload.processElapsedMs)}`);
  console.log(`workflow_graph_visible nodeCount=${fmt(graphVisible.payload.nodeCount)} edgeCount=${fmt(graphVisible.payload.edgeCount)} elapsedMs=${fmt(graphVisible.payload.elapsedMs)} processElapsedMs=${fmt(graphVisible.payload.processElapsedMs)} wallWaitMs=${graphVisibleWallMs}`);
  if (taskGraphVisible) {
    console.log(`task_graph_visible nodeCount=${fmt(taskGraphVisible.payload.nodeCount)} edgeCount=${fmt(taskGraphVisible.payload.edgeCount)} elapsedMs=${fmt(taskGraphVisible.payload.elapsedMs)} processElapsedMs=${fmt(taskGraphVisible.payload.processElapsedMs)}`);
  } else {
    console.log('task_graph_visible nodeCount=n/a edgeCount=n/a elapsedMs=n/a processElapsedMs=n/a');
  }

  if (redundant) {
    const p = redundant.payload;
    console.log(`snapshot_after_bootstrap observed=true forced=${fmt(p.forceRefresh)} taskCount=${fmt(p.taskCount)} workflowCount=${fmt(p.workflowCount)} jsonSizeBytes=${fmt(p.jsonSizeBytes)} requestDurationMs=${fmt(p.requestDurationMs)} replaceDurationMs=${fmt(p.replaceDurationMs)}`);
  } else {
    console.log('snapshot_after_bootstrap observed=false forced=n/a taskCount=n/a workflowCount=n/a jsonSizeBytes=n/a requestDurationMs=n/a replaceDurationMs=n/a');
  }
  console.log(`final_counts taskCount=${result.taskCount} workflowCount=${result.workflowCount} processStartupWallMs=${Date.now() - startedAt}`);

  return Boolean(redundant);
}

async function main() {
  mkdirp(stubDir);
  mkdirp(markerRoot);
  mkdirp(dbDir);
  fs.writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  linkOrCopy(claudeMarker, path.join(stubDir, 'claude'));
  linkOrCopy(codexMarker, path.join(stubDir, 'codex'));

  if (!headful && process.platform === 'linux' && !process.env.DISPLAY) {
    console.log('[repro] DISPLAY is not set; Playwright/Electron will rely on the environment headless support or xvfb-run from the caller.');
  }

  const app = await launchApp({ INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000' });
  let observedIssue;
  try {
    const page = await firstWindow(app);
    await seedFixture(page);
    observedIssue = await collectStartupEvidence(page);
  } finally {
    await app.close();
  }

  if (expectIssue) {
    if (observedIssue) {
      console.log('[repro] PASS: observed redundant non-forced post-bootstrap snapshot replace.');
      return;
    }
    console.error('[repro] FAIL: expected redundant non-forced post-bootstrap snapshot replace, but none was observed.');
    process.exitCode = 1;
    return;
  }

  if (observedIssue) {
    console.error('[repro] FAIL: redundant non-forced post-bootstrap snapshot replace is still present.');
    process.exitCode = 1;
    return;
  }
  console.log('[repro] PASS: no redundant non-forced post-bootstrap snapshot replace observed.');
}

main().catch((error) => {
  console.error(`[repro] ERROR: ${error && error.stack ? error.stack : error}`);
  process.exitCode = error && error.exitCode ? error.exitCode : 1;
});
NODE
}

if [ "${REPRO_HEADFUL:-0}" != "1" ] && [ "$(uname)" = "Linux" ] && [ -z "${DISPLAY:-}" ] && command -v xvfb-run >/dev/null 2>&1; then
  xvfb-run --auto-servernum bash -c "$(declare -f run_node); run_node"
else
  run_node
fi

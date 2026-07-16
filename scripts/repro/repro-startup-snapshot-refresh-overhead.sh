#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

EXPECT_ISSUE=0
KEEP_TMP=0
WORKFLOW_COUNT="${INVOKER_REPRO_STARTUP_WORKFLOWS:-30}"
TASKS_PER_WORKFLOW="${INVOKER_REPRO_STARTUP_TASKS_PER_WORKFLOW:-8}"
WAIT_AFTER_VISIBLE_MS="${INVOKER_REPRO_STARTUP_WAIT_AFTER_VISIBLE_MS:-8000}"
INVOKER_READY_TIMEOUT_MS="${INVOKER_REPRO_INVOKER_READY_TIMEOUT_MS:-30000}"
TIMEOUT_SECONDS="${INVOKER_REPRO_TIMEOUT_SECONDS:-300}"

usage() {
  cat <<'USAGE'
Usage: scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue] [--keep-tmp]

Seeds an isolated startup fixture with multiple workflows/tasks, relaunches the
Electron app, and reports startup ui-perf/activity_log metrics for the redundant
post-bootstrap useTasks snapshot replacement.

Options:
  --expect-issue  Exit 0 only when the redundant non-forced snapshot is observed.
  --keep-tmp      Keep the isolated temp DB/repo for debugging.

Environment:
  INVOKER_REPRO_STARTUP_WORKFLOWS             Default: 30
  INVOKER_REPRO_STARTUP_TASKS_PER_WORKFLOW    Default: 8
  INVOKER_REPRO_STARTUP_WAIT_AFTER_VISIBLE_MS Default: 8000
  INVOKER_REPRO_INVOKER_READY_TIMEOUT_MS      Default: 30000
  INVOKER_REPRO_TIMEOUT_SECONDS               Default: 300
  INVOKER_REPRO_SKIP_BUILD=1                  Reuse existing dist artifacts.
USAGE
}

while (($#)); do
  case "$1" in
    --expect-issue)
      EXPECT_ISSUE=1
      shift
      ;;
    --keep-tmp)
      KEEP_TMP=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

if ! command -v pnpm >/dev/null 2>&1; then
  echo "pnpm is required" >&2
  exit 127
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 127
fi

if ! command -v git >/dev/null 2>&1; then
  echo "git is required" >&2
  exit 127
fi

if [[ "$(uname)" = "Linux" && -z "${DISPLAY:-}" ]] && ! command -v xvfb-run >/dev/null 2>&1; then
  echo "xvfb-run is required on Linux when DISPLAY is not set" >&2
  exit 127
fi

has_bootstrap_artifacts() {
  [[ -f "$ROOT/node_modules/.modules.yaml" ]] \
    && [[ -x "$ROOT/packages/ui/node_modules/.bin/vite" ]] \
    && [[ -x "$ROOT/packages/app/node_modules/.bin/electron" ]]
}

if ! has_bootstrap_artifacts || [[ "${INVOKER_FORCE_BOOTSTRAP:-0}" = "1" ]]; then
  pnpm install --frozen-lockfile
fi

if [[ "${INVOKER_REPRO_SKIP_BUILD:-0}" != "1" ]]; then
  pnpm --filter @invoker/ui build
  pnpm --filter @invoker/surfaces build
  pnpm --filter @invoker/app build
fi

if [[ ! -f "$ROOT/packages/ui/dist/index.html" || ! -f "$ROOT/packages/app/dist/main.js" ]]; then
  echo "Missing built app artifacts; rerun without INVOKER_REPRO_SKIP_BUILD=1" >&2
  exit 1
fi

TMP_ROOT="$(mktemp -d -t invoker-startup-snapshot-repro.XXXXXX)"
DRIVER_DIR="$ROOT/packages/app/.repro-startup-snapshot-refresh-overhead"
DRIVER="$DRIVER_DIR/driver.mjs"
mkdir -p "$DRIVER_DIR"

cleanup() {
  rm -rf "$DRIVER_DIR"
  if [[ "$KEEP_TMP" != "1" ]]; then
    rm -rf "$TMP_ROOT"
  else
    echo "Kept temp fixture: $TMP_ROOT" >&2
  fi
}
trap cleanup EXIT

BARE_REPO="$TMP_ROOT/repo.git"
SETUP_CLONE="$TMP_ROOT/repo.setup"
git -c init.defaultBranch=main init --bare "$BARE_REPO" >/dev/null
env \
  GIT_AUTHOR_NAME="Invoker Repro" \
  GIT_AUTHOR_EMAIL="ci@invoker.dev" \
  GIT_COMMITTER_NAME="Invoker Repro" \
  GIT_COMMITTER_EMAIL="ci@invoker.dev" \
  git clone "$BARE_REPO" "$SETUP_CLONE" >/dev/null 2>&1
env \
  GIT_AUTHOR_NAME="Invoker Repro" \
  GIT_AUTHOR_EMAIL="ci@invoker.dev" \
  GIT_COMMITTER_NAME="Invoker Repro" \
  GIT_COMMITTER_EMAIL="ci@invoker.dev" \
  git -C "$SETUP_CLONE" commit --allow-empty -m "init" >/dev/null
git -C "$SETUP_CLONE" push origin HEAD:refs/heads/master >/dev/null 2>&1
git -C "$SETUP_CLONE" push origin HEAD:refs/heads/main >/dev/null 2>&1
rm -rf "$SETUP_CLONE"

cat >"$DRIVER" <<'JS'
import { _electron as electron } from '@playwright/test';
import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { stringify as yamlStringify } from 'yaml';

const root = process.env.REPRO_ROOT;
const dbDir = process.env.REPRO_DB_DIR;
const bareRepo = process.env.REPRO_BARE_REPO;
const workflowCount = Number(process.env.REPRO_WORKFLOW_COUNT ?? '30');
const tasksPerWorkflow = Number(process.env.REPRO_TASKS_PER_WORKFLOW ?? '8');
const waitAfterVisibleMs = Number(process.env.REPRO_WAIT_AFTER_VISIBLE_MS ?? '8000');
const expectIssue = process.env.REPRO_EXPECT_ISSUE === '1';
const invokerReadyTimeoutMs = Number(process.env.REPRO_INVOKER_READY_TIMEOUT_MS ?? '30000');

if (!root || !dbDir || !bareRepo) {
  throw new Error('Missing REPRO_ROOT, REPRO_DB_DIR, or REPRO_BARE_REPO');
}
if (!Number.isInteger(workflowCount) || workflowCount <= 0) {
  throw new Error(`Invalid workflow count: ${workflowCount}`);
}
if (!Number.isInteger(tasksPerWorkflow) || tasksPerWorkflow <= 0) {
  throw new Error(`Invalid tasks per workflow: ${tasksPerWorkflow}`);
}

const appMain = path.join(root, 'packages', 'app', 'dist', 'main.js');
const claudeMarker = path.join(root, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const repoUrl = pathToFileURL(bareRepo).href;

function buildPlan(index) {
  return {
    name: `Startup Snapshot Repro ${String(index).padStart(2, '0')}`,
    repoUrl,
    onFinish: 'none',
    tasks: Array.from({ length: tasksPerWorkflow }, (_, taskIndex) => ({
      id: `task-${index}-${taskIndex}`,
      description: `Startup snapshot repro task ${index}-${taskIndex}`,
      command: `echo startup-snapshot-repro-${index}-${taskIndex}`,
      dependencies: taskIndex === 0 ? [] : [`task-${index}-${taskIndex - 1}`],
    })),
  };
}

async function launchApp(label, extraEnv = {}) {
  const runDir = mkdtempSync(path.join(tmpdir(), `invoker-startup-snapshot-${label}-`));
  const stubDir = path.join(runDir, 'claude-stub');
  const markerRoot = path.join(runDir, 'e2e-markers');
  const configPath = path.join(runDir, 'config.json');
  const ipcSocketPath = path.join(runDir, 'ipc.sock');
  await mkdir(stubDir, { recursive: true });
  await mkdir(markerRoot, { recursive: true });
  await writeFile(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {
    // The explicit command env vars below keep this deterministic if symlinks are unavailable.
  }

  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
        : []),
      appMain,
    ],
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
      INVOKER_CLAUDE_COMMAND: claudeMarker,
      INVOKER_CLAUDE_FIX_COMMAND: claudeMarker,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH ?? ''}`,
      ...extraEnv,
    },
  });
  return { app, runDir };
}

function parsePayload(entry) {
  try {
    return JSON.parse(entry.message);
  } catch {
    return null;
  }
}

function metricEntries(activityLogs, afterId = 0) {
  return activityLogs
    .filter((entry) => Number(entry.id ?? 0) > afterId)
    .map((entry) => ({ entry, payload: parsePayload(entry) }))
    .filter(({ entry, payload }) => entry.source === 'ui-perf' && payload && typeof payload.metric === 'string')
    .sort((a, b) => Number(a.entry.id ?? 0) - Number(b.entry.id ?? 0));
}

function fmt(value) {
  if (value === undefined || value === null || value === '') return 'n/a';
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(3).replace(/\.?0+$/, '');
  return String(value);
}

function boolFmt(value) {
  return value === true ? 'true' : value === false ? 'false' : 'n/a';
}

async function waitForInvoker(page, label) {
  try {
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, {
      timeout: invokerReadyTimeoutMs,
    });
  } catch (error) {
    const url = page.url();
    const title = await page.title().catch(() => 'n/a');
    const body = await page.locator('body').innerText({ timeout: 1000 }).catch(() => 'n/a');
    throw new Error(`${label}: timed out waiting for preload bridge after ${invokerReadyTimeoutMs}ms; url=${url}; title=${title}; body=${body.slice(0, 500)}`, {
      cause: error,
    });
  }
}

async function main() {
  const minimumSeedTaskCount = workflowCount * tasksPerWorkflow;
  let seedMaxActivityLogId = 0;

  const seed = await launchApp('seed');
  try {
    const page = await seed.app.firstWindow({ timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await waitForInvoker(page, 'seed launch');

    for (let index = 0; index < workflowCount; index += 1) {
      const planYaml = yamlStringify(buildPlan(index));
      await page.evaluate((text) => window.invoker.loadPlan(text), planYaml);
    }

    const seeded = await page.evaluate(async () => {
      const result = await window.invoker.getTasks(true);
      const tasks = Array.isArray(result) ? result : result.tasks;
      const workflows = Array.isArray(result) ? [] : result.workflows ?? [];
      const logs = await window.invoker.getActivityLogs();
      return { taskCount: tasks.length, workflowCount: workflows.length, logs };
    });

    seedMaxActivityLogId = Math.max(0, ...seeded.logs.map((entry) => Number(entry.id ?? 0)));
    if (seeded.taskCount < minimumSeedTaskCount || seeded.workflowCount !== workflowCount) {
      throw new Error(`Seed mismatch: tasks=${seeded.taskCount}/>=${minimumSeedTaskCount}, workflows=${seeded.workflowCount}/${workflowCount}`);
    }
  } finally {
    await seed.app.close().catch(() => undefined);
    rmSync(seed.runDir, { recursive: true, force: true });
  }

  const startup = await launchApp('startup', {
    INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000',
  });
  try {
    const page = await startup.app.firstWindow({ timeout: 15000 });
    await page.waitForLoadState('domcontentloaded');
    await waitForInvoker(page, 'startup relaunch');
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForTimeout(waitAfterVisibleMs);

    const result = await page.evaluate(async () => {
      return {
        perf: await window.invoker.getUiPerfStats(),
        activityLogs: await window.invoker.getActivityLogs(),
      };
    });

    const metrics = metricEntries(result.activityLogs, seedMaxActivityLogId);
    const bootstrapIndex = metrics.findIndex(({ payload }) => payload.metric === 'preload_bootstrap_sync');
    const bootstrap = bootstrapIndex >= 0 ? metrics[bootstrapIndex].payload : null;
    const replacements = metrics
      .map((item, index) => ({ ...item, index }))
      .filter(({ payload }) => payload.metric === 'useTasks_snapshot_replace');
    const redundant = replacements.find(
      ({ index, payload }) => index > bootstrapIndex && payload.forceRefresh !== true,
    );
    const firstReplacement = redundant ?? replacements[0] ?? null;
    const workflowVisible = metrics.find(({ payload }) => payload.metric === 'startup_workflow_graph_visible')?.payload ?? null;
    const taskGraphVisible = metrics.find(({ payload }) => payload.metric === 'startup_graph_visible')?.payload ?? null;

    if (!bootstrap) {
      throw new Error('Did not observe preload_bootstrap_sync in startup activity_log');
    }
    if (!workflowVisible) {
      throw new Error('Did not observe startup_workflow_graph_visible in startup activity_log');
    }

    console.log(`fixture.workflows=${workflowCount}`);
    console.log(`fixture.tasksPerWorkflow=${tasksPerWorkflow}`);
    console.log(`bootstrap.taskCount=${fmt(bootstrap.taskCount)}`);
    console.log(`bootstrap.workflowCount=${fmt(bootstrap.workflowCount)}`);
    console.log(`bootstrap.jsonSizeBytes=${fmt(bootstrap.jsonSizeBytes)}`);
    console.log(`useTasks_snapshot_replace.observed=${firstReplacement ? 'true' : 'false'}`);
    console.log(`useTasks_snapshot_replace.requestDurationMs=${fmt(firstReplacement?.payload.requestDurationMs)}`);
    console.log(`useTasks_snapshot_replace.replaceDurationMs=${fmt(firstReplacement?.payload.replaceDurationMs)}`);
    console.log(`useTasks_snapshot_replace.forceRefresh=${boolFmt(firstReplacement?.payload.forceRefresh)}`);
    console.log(`startup_workflow_graph_visible.elapsedMs=${fmt(workflowVisible.elapsedMs)}`);
    console.log(`startup_workflow_graph_visible.processElapsedMs=${fmt(workflowVisible.processElapsedMs)}`);
    console.log(`startup_workflow_graph_visible.nodeCount=${fmt(workflowVisible.nodeCount)}`);
    console.log(`startup_workflow_graph_visible.edgeCount=${fmt(workflowVisible.edgeCount)}`);
    console.log(`startup_graph_visible.elapsedMs=${fmt(taskGraphVisible?.elapsedMs)}`);
    console.log(`startup_graph_visible.processElapsedMs=${fmt(taskGraphVisible?.processElapsedMs)}`);
    console.log(`startup_graph_visible.nodeCount=${fmt(taskGraphVisible?.nodeCount)}`);
    console.log(`uiPerf.rendererReports=${fmt(result.perf?.rendererReports)}`);
    console.log(`activityLog.startupMetricCount=${metrics.length}`);
    console.log(`redundantNonForcedStartupSnapshot=${redundant ? 'true' : 'false'}`);

    if (expectIssue) {
      if (redundant) {
        console.log('result=observed expected redundant non-forced startup snapshot');
        return;
      }
      console.error('Expected redundant non-forced startup snapshot, but none was observed.');
      process.exitCode = 1;
      return;
    }

    if (redundant) {
      console.error('Observed redundant non-forced useTasks_snapshot_replace after preload_bootstrap_sync.');
      process.exitCode = 1;
      return;
    }
    console.log('result=no redundant non-forced startup snapshot observed');
  } finally {
    await startup.app.close().catch(() => undefined);
    rmSync(startup.runDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
JS

RUN_CMD=(node "$DRIVER")
if command -v timeout >/dev/null 2>&1; then
  RUN_CMD=(timeout "$TIMEOUT_SECONDS" "${RUN_CMD[@]}")
fi

if [[ "$(uname)" = "Linux" && -z "${DISPLAY:-}" ]]; then
  RUN_CMD=(xvfb-run --auto-servernum "${RUN_CMD[@]}")
fi

env \
  REPRO_ROOT="$ROOT" \
  REPRO_DB_DIR="$TMP_ROOT/db" \
  REPRO_BARE_REPO="$BARE_REPO" \
  REPRO_WORKFLOW_COUNT="$WORKFLOW_COUNT" \
  REPRO_TASKS_PER_WORKFLOW="$TASKS_PER_WORKFLOW" \
  REPRO_WAIT_AFTER_VISIBLE_MS="$WAIT_AFTER_VISIBLE_MS" \
  REPRO_INVOKER_READY_TIMEOUT_MS="$INVOKER_READY_TIMEOUT_MS" \
  REPRO_EXPECT_ISSUE="$EXPECT_ISSUE" \
  "${RUN_CMD[@]}"

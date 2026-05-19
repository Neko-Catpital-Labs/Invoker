#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

EXPECT_ISSUE=0
for arg in "$@"; do
  case "$arg" in
    --expect-issue)
      EXPECT_ISSUE=1
      ;;
    -h|--help)
      cat <<'USAGE'
Usage: bash scripts/repro/repro-startup-snapshot-refresh-overhead.sh [--expect-issue]

Proves whether startup performs a redundant non-forced
useTasks_snapshot_replace request after preload_bootstrap_sync.

Environment overrides:
  REPRO_WORKFLOW_COUNT            default: 12
  REPRO_TASKS_PER_WORKFLOW        default: 8
  REPRO_TIMEOUT_SECONDS           default: 600
  REPRO_TIMEOUT_MS                default: 30000
  REPRO_POST_VISIBLE_WAIT_MS      default: 700
  REPRO_HEADFUL=1                 disable xvfb wrapping
  KEEP_REPRO_HOME=1               keep temporary fixture directory
USAGE
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

if [[ "${_REPRO_TIMEOUT_WRAPPED:-0}" != "1" ]] && command -v timeout >/dev/null 2>&1; then
  exec timeout --preserve-status "${REPRO_TIMEOUT_SECONDS:-600}" \
    env _REPRO_TIMEOUT_WRAPPED=1 bash "$0" "$@"
fi

if [[ "$(uname -s)" == "Linux" && -z "${DISPLAY:-}" && "${REPRO_HEADFUL:-0}" != "1" && "${_REPRO_XVFB_WRAPPED:-0}" != "1" ]]; then
  if command -v xvfb-run >/dev/null 2>&1; then
    exec xvfb-run --auto-servernum env _REPRO_XVFB_WRAPPED=1 bash "$0" "$@"
  fi
fi

run_with_heartbeat() {
  local label="$1"
  shift
  "$@" &
  local pid="$!"
  while kill -0 "$pid" >/dev/null 2>&1; do
    sleep 20
    if kill -0 "$pid" >/dev/null 2>&1; then
      echo "[repro] still running: $label"
    fi
  done
  wait "$pid"
}

if [[ ! -d "$ROOT/node_modules" || ! -f "$ROOT/packages/ui/node_modules/autoprefixer/lib/autoprefixer.js" || ! -f "$ROOT/packages/app/node_modules/@playwright/test/package.json" ]]; then
  echo "[repro] installing workspace dependencies"
  run_with_heartbeat "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile
fi

if [[ ! -f "$ROOT/packages/ui/dist/index.html" ]]; then
  echo "[repro] building @invoker/ui"
  run_with_heartbeat "pnpm --filter @invoker/ui build" pnpm --filter @invoker/ui build
fi

if [[ ! -f "$ROOT/packages/surfaces/dist/index.js" ]]; then
  echo "[repro] building @invoker/surfaces"
  run_with_heartbeat "pnpm --filter @invoker/surfaces build" pnpm --filter @invoker/surfaces build
fi

if [[ ! -f "$ROOT/packages/app/dist/main.js" ]]; then
  echo "[repro] building @invoker/app"
  run_with_heartbeat "pnpm --filter @invoker/app build" pnpm --filter @invoker/app build
fi

REPRO_HOME="${REPRO_HOME:-$(mktemp -d "${TMPDIR:-/tmp}/invoker-startup-snapshot-repro.XXXXXX")}"
NODE_SCRIPT="$REPRO_HOME/repro-startup-snapshot-refresh-overhead.mjs"

cleanup() {
  if [[ "${KEEP_REPRO_HOME:-0}" != "1" ]]; then
    rm -rf "$REPRO_HOME"
  else
    echo "[repro] kept fixture directory: $REPRO_HOME"
  fi
}
trap cleanup EXIT

cat >"$NODE_SCRIPT" <<'NODE'
import { _electron as electron } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.REPRO_ROOT;
const reproHome = process.env.REPRO_HOME;
const expectIssue = process.env.REPRO_EXPECT_ISSUE === '1';
const workflowCount = Number.parseInt(process.env.REPRO_WORKFLOW_COUNT ?? '12', 10);
const tasksPerWorkflow = Number.parseInt(process.env.REPRO_TASKS_PER_WORKFLOW ?? '8', 10);
const timeoutMs = Number.parseInt(process.env.REPRO_TIMEOUT_MS ?? '30000', 10);
const postVisibleWaitMs = Number.parseInt(process.env.REPRO_POST_VISIBLE_WAIT_MS ?? '700', 10);

if (!root || !reproHome) throw new Error('REPRO_ROOT and REPRO_HOME are required');
if (!Number.isFinite(workflowCount) || workflowCount < 2) throw new Error('REPRO_WORKFLOW_COUNT must be >= 2');
if (!Number.isFinite(tasksPerWorkflow) || tasksPerWorkflow < 2) throw new Error('REPRO_TASKS_PER_WORKFLOW must be >= 2');

const appMain = path.join(root, 'packages', 'app', 'dist', 'main.js');
const claudeMarker = path.join(root, 'scripts', 'e2e-dry-run', 'fixtures', 'claude-marker.sh');
const fixtureDir = path.join(reproHome, 'app-state');
const repoBare = path.join(reproHome, 'repo.git');
const repoClone = path.join(reproHome, 'repo-work');
const stubDir = path.join(reproHome, 'claude-stub');
const markerRoot = path.join(reproHome, 'markers');
const configPath = path.join(reproHome, 'config.json');
let launchCounter = 0;

function runGit(args, opts = {}) {
  execFileSync('git', args, {
    stdio: opts.stdio ?? 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Invoker Repro',
      GIT_AUTHOR_EMAIL: 'repro@invoker.dev',
      GIT_COMMITTER_NAME: 'Invoker Repro',
      GIT_COMMITTER_EMAIL: 'repro@invoker.dev',
    },
    cwd: opts.cwd,
  });
}

async function setupFixture() {
  await fsp.mkdir(fixtureDir, { recursive: true });
  await fsp.mkdir(stubDir, { recursive: true });
  await fsp.mkdir(markerRoot, { recursive: true });
  await fsp.writeFile(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');
  try {
    await fsp.symlink(claudeMarker, path.join(stubDir, 'claude'));
  } catch {
    await fsp.copyFile(claudeMarker, path.join(stubDir, 'claude'));
    await fsp.chmod(path.join(stubDir, 'claude'), 0o755);
  }

  runGit(['init', '--bare', repoBare]);
  runGit(['clone', repoBare, repoClone]);
  await fsp.writeFile(path.join(repoClone, 'README.md'), 'startup snapshot repro\n', 'utf8');
  runGit(['add', 'README.md'], { cwd: repoClone });
  runGit(['commit', '-m', 'init'], { cwd: repoClone });
  runGit(['push', 'origin', 'HEAD:refs/heads/main'], { cwd: repoClone });
  runGit(['push', 'origin', 'HEAD:refs/heads/master'], { cwd: repoClone });
}

function electronArgs() {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    appMain,
  ];
}

async function launchApp(extraEnv = {}) {
  launchCounter += 1;
  return electron.launch({
    args: electronArgs(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      TZ: 'UTC',
      INVOKER_DB_DIR: fixtureDir,
      INVOKER_IPC_SOCKET: path.join(reproHome, `ipc-${launchCounter}.sock`),
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
}

function planYaml(index) {
  const lines = [
    `name: Startup Snapshot Repro ${index}`,
    `repoUrl: ${pathToFileURL(repoBare).href}`,
    'onFinish: none',
    'tasks:',
  ];
  for (let taskIndex = 0; taskIndex < tasksPerWorkflow; taskIndex += 1) {
    lines.push(`  - id: task-${index}-${taskIndex}`);
    lines.push(`    description: Task ${index}-${taskIndex}`);
    lines.push(`    command: echo task-${index}-${taskIndex}`);
    if (taskIndex === 0) {
      lines.push('    dependencies: []');
    } else {
      lines.push('    dependencies:');
      lines.push(`      - task-${index}-${taskIndex - 1}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function parsePayload(entry) {
  try {
    return JSON.parse(entry.message);
  } catch {
    return null;
  }
}

function numberOrBlank(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : String(value ?? 'n/a');
}

async function firstPage(app) {
  const page = await app.firstWindow({ timeout: timeoutMs });
  await page.waitForLoadState('domcontentloaded', { timeout: timeoutMs });
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: timeoutMs });
  return page;
}

async function main() {
  await setupFixture();

  const seedApp = await launchApp();
  let seedMaxActivityLogId = 0;
  try {
    const page = await firstPage(seedApp);
    for (let index = 0; index < workflowCount; index += 1) {
      await page.evaluate(async (planText) => window.invoker.loadPlan(planText), planYaml(index));
    }
    const seeded = await page.evaluate(async () => {
      const tasksResult = await window.invoker.getTasks(true);
      const logs = await window.invoker.getActivityLogs();
      return {
        taskCount: Array.isArray(tasksResult) ? tasksResult.length : tasksResult.tasks.length,
        workflowCount: Array.isArray(tasksResult) ? undefined : tasksResult.workflows.length,
        maxLogId: logs.reduce((max, entry) => Math.max(max, entry.id), 0),
      };
    });
    seedMaxActivityLogId = seeded.maxLogId;
    if (seeded.taskCount !== workflowCount * tasksPerWorkflow) {
      throw new Error(`seeded ${seeded.taskCount} tasks, expected ${workflowCount * tasksPerWorkflow}`);
    }
  } finally {
    await seedApp.close();
  }

  const startupStartedAt = Date.now();
  const app = await launchApp({ INVOKER_TEST_RESUME_PENDING_DELAY_MS: '15000' });
  try {
    const page = await firstPage(app);
    await page.locator('[data-testid^="workflow-node-"]').first().waitFor({ state: 'visible', timeout: timeoutMs });
    const graphVisibleWallMs = Date.now() - startupStartedAt;
    await page.waitForTimeout(postVisibleWaitMs);

    const result = await page.evaluate(async () => {
      const logs = await window.invoker.getActivityLogs();
      return { logs };
    });

    const uiPerf = result.logs
      .filter((entry) => entry.id > seedMaxActivityLogId && entry.source === 'ui-perf')
      .map((entry) => ({ id: entry.id, payload: parsePayload(entry) }))
      .filter((entry) => entry.payload);

    const bootstrap = uiPerf.find((entry) => entry.payload.metric === 'preload_bootstrap_sync');
    const workflowGraphVisible = uiPerf.find((entry) => entry.payload.metric === 'startup_workflow_graph_visible');
    const taskGraphVisible = uiPerf.find((entry) => entry.payload.metric === 'startup_graph_visible');
    const postBootstrapSnapshots = bootstrap
      ? uiPerf.filter((entry) =>
          entry.id > bootstrap.id
          && entry.payload.metric === 'useTasks_snapshot_replace'
          && entry.payload.forceRefresh !== true)
      : [];
    const redundantSnapshot = postBootstrapSnapshots[0];

    if (!bootstrap || !workflowGraphVisible) {
      console.log('[repro] ui-perf metrics observed after relaunch:');
      for (const entry of uiPerf) {
        console.log(`  #${entry.id} ${entry.payload.metric}`);
      }
      console.error('[repro] missing required startup ui-perf evidence');
      process.exit(2);
    }

    console.log('[repro] startup snapshot refresh overhead');
    console.log(`  fixture: workflows=${workflowCount} tasksPerWorkflow=${tasksPerWorkflow} expectedTasks=${workflowCount * tasksPerWorkflow}`);
    console.log(`  bootstrap: durationMs=${numberOrBlank(bootstrap.payload.durationMs)} taskCount=${bootstrap.payload.taskCount ?? 'n/a'} workflowCount=${bootstrap.payload.workflowCount ?? 'n/a'} jsonSizeBytes=${bootstrap.payload.jsonSizeBytes ?? 'n/a'}`);
    console.log(`  workflow graph visible: wallMs=${graphVisibleWallMs} elapsedMs=${workflowGraphVisible.payload.elapsedMs ?? 'n/a'} processElapsedMs=${workflowGraphVisible.payload.processElapsedMs ?? 'n/a'} nodeCount=${workflowGraphVisible.payload.nodeCount ?? 'n/a'} edgeCount=${workflowGraphVisible.payload.edgeCount ?? 'n/a'}`);
    if (taskGraphVisible) {
      console.log(`  task graph visible: elapsedMs=${taskGraphVisible.payload.elapsedMs ?? 'n/a'} processElapsedMs=${taskGraphVisible.payload.processElapsedMs ?? 'n/a'} nodeCount=${taskGraphVisible.payload.nodeCount ?? 'n/a'} edgeCount=${taskGraphVisible.payload.edgeCount ?? 'n/a'}`);
    } else {
      console.log('  task graph visible: n/a');
    }

    if (redundantSnapshot) {
      const payload = redundantSnapshot.payload;
      console.log(`  snapshot after bootstrap: observed=true forced=${String(payload.forceRefresh === true)} taskCount=${payload.taskCount ?? 'n/a'} workflowCount=${payload.workflowCount ?? 'n/a'} jsonSizeBytes=${payload.jsonSizeBytes ?? 'n/a'}`);
      console.log(`  useTasks_snapshot_replace.requestDurationMs=${numberOrBlank(payload.requestDurationMs)}`);
      console.log(`  useTasks_snapshot_replace.replaceDurationMs=${numberOrBlank(payload.replaceDurationMs)}`);
      if (expectIssue) {
        console.log('[repro] issue reproduced: non-forced useTasks_snapshot_replace occurred after preload_bootstrap_sync');
        process.exit(0);
      }
      console.error('[repro] redundant non-forced startup snapshot still occurs');
      process.exit(1);
    }

    console.log('  snapshot after bootstrap: observed=false forced=n/a taskCount=n/a workflowCount=n/a jsonSizeBytes=n/a');
    console.log('  useTasks_snapshot_replace.requestDurationMs=n/a');
    console.log('  useTasks_snapshot_replace.replaceDurationMs=n/a');
    if (expectIssue) {
      console.error('[repro] expected issue, but no redundant non-forced post-bootstrap snapshot was observed');
      process.exit(1);
    }
    console.log('[repro] fixed: no redundant non-forced startup snapshot observed');
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exit(2);
});
NODE

chmod +x "$NODE_SCRIPT"

echo "[repro] fixture directory: $REPRO_HOME"
cd "$ROOT/packages/app"
REPRO_ROOT="$ROOT" \
REPRO_HOME="$REPRO_HOME" \
REPRO_EXPECT_ISSUE="$EXPECT_ISSUE" \
REPRO_WORKFLOW_COUNT="${REPRO_WORKFLOW_COUNT:-12}" \
REPRO_TASKS_PER_WORKFLOW="${REPRO_TASKS_PER_WORKFLOW:-8}" \
REPRO_TIMEOUT_MS="${REPRO_TIMEOUT_MS:-30000}" \
REPRO_POST_VISIBLE_WAIT_MS="${REPRO_POST_VISIBLE_WAIT_MS:-700}" \
  pnpm exec node "$NODE_SCRIPT"

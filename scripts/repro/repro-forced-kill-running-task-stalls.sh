#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="issue"
KEEP_ARTIFACTS=0
STALL_TIMEOUT_MS="${STALL_TIMEOUT_MS:-3000}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-forced-kill-running-task-stalls.sh [--expect issue|fixed] [--keep-artifacts]

What it proves:
  A forced Electron process kill drops the in-memory execution handle without
  running the app's normal before-quit cleanup. On relaunch, the task is still
  marked running instead of being failed immediately as "Application quit".
  That orphaned running state is the root cause of the later confusing stall.

Exit codes:
  0  observed behavior matches --expect
  1  observed behavior does not match --expect
  2  invalid args or missing local tooling
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "repro: unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "repro: --expect requires issue|fixed" >&2
  exit 2
fi
if [[ ! -f "$ROOT_DIR/packages/app/dist/main.js" ]]; then
  echo "repro: missing packages/app/dist/main.js; run 'pnpm --filter @invoker/app build' first." >&2
  exit 2
fi
if [[ ! -d "$ROOT_DIR/packages/app/node_modules/@playwright" && ! -d "$ROOT_DIR/packages/app/node_modules/playwright" ]]; then
  echo "repro: missing Playwright package under packages/app/node_modules; run 'pnpm install' first." >&2
  exit 2
fi

cd "$ROOT_DIR/packages/app"
EXPECTATION="$EXPECTATION" STALL_TIMEOUT_MS="$STALL_TIMEOUT_MS" KEEP_ARTIFACTS="$KEEP_ARTIFACTS" ROOT_DIR="$ROOT_DIR" node --input-type=module <<'EOF'
import { _electron as electron } from '@playwright/test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';

const ROOT_DIR = process.env.ROOT_DIR;
const EXPECTATION = process.env.EXPECTATION;
const STALL_TIMEOUT_MS = process.env.STALL_TIMEOUT_MS ?? '3000';
const KEEP_ARTIFACTS = process.env.KEEP_ARTIFACTS === '1';
const MAIN_JS = path.resolve(ROOT_DIR, 'packages/app/dist/main.js');

const REPRO_PLAN = {
  name: 'Forced kill execution stall repro',
  repoUrl: '',
  onFinish: 'none',
  tasks: [
    {
      id: 'slow-task',
      description: 'long-running task for forced-kill repro',
      command: 'sleep 30',
    },
  ],
};

function launchArgs() {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    MAIN_JS,
  ];
}

async function waitForInvoker(page) {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

async function loadPlan(page, plan) {
  const planYaml = [
    `name: ${plan.name}`,
    `repoUrl: ${plan.repoUrl}`,
    `onFinish: ${plan.onFinish}`,
    'tasks:',
    ...plan.tasks.flatMap((task) => [
      `  - id: ${task.id}`,
      `    description: ${task.description}`,
      `    command: ${task.command}`,
    ]),
  ].join('\n');
  await page.evaluate((yaml) => window.invoker.loadPlan(yaml), planYaml);
  await page.waitForTimeout(50);
  await page.getByTestId('sidebar-home').click();
  await page.locator(`.react-flow__node[data-testid$="${plan.tasks[0].id}"]`).first().waitFor({ state: 'visible', timeout: 10000 });
}

async function startPlan(page) {
  await page.evaluate(() => window.invoker.start());
}

async function getTasks(page) {
  const result = await page.evaluate(() => window.invoker.getTasks());
  return Array.isArray(result) ? result : result.tasks;
}

function findTaskByIdSuffix(tasks, rawId) {
  return tasks.find((task) => task.id === rawId || task.id.endsWith(`/${rawId}`));
}

async function launchApp(testDir, configPath, userDataDir, ipcSocketPath) {
  return electron.launch({
    args: [`--user-data-dir=${userDataDir}`, ...launchArgs()],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_GUI_OWNER_MODE: 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_EXECUTING_STALL_TIMEOUT_MS: STALL_TIMEOUT_MS,
      INVOKER_STARTUP_POLL_DELAY_MS: '0',
      INVOKER_USER_DATA_DIR: userDataDir,
    },
  });
}

async function closeApp(app) {
  if (!app) return;
  const child = app.process();
  let childExited = child.exitCode !== null || child.signalCode !== null;
  const childExitPromise = new Promise((resolve) => {
    const done = () => {
      childExited = true;
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
  });
  const closePromise = app.close().catch(() => undefined);
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    new Promise((resolve) => setTimeout(() => resolve(true), 5000)),
  ]);
  if (timedOut && !childExited) {
    child.kill('SIGTERM');
    await Promise.race([
      closePromise,
      childExitPromise,
      new Promise((resolve) => setTimeout(resolve, 2000)),
    ]);
    if (!childExited) {
      child.kill('SIGKILL');
      await childExitPromise;
    }
  }
}

async function killElectronProcess(app) {
  const child = app.process();
  let childExited = child.exitCode !== null || child.signalCode !== null;
  const childExitPromise = new Promise((resolve) => {
    const done = () => {
      childExited = true;
      resolve();
    };
    child.once('exit', done);
    child.once('close', done);
  });
  child.kill('SIGTERM');
  await Promise.race([
    childExitPromise,
    new Promise((resolve) => setTimeout(resolve, 2000)),
  ]);
  if (!childExited) {
    child.kill('SIGKILL');
    await childExitPromise;
  }
}

async function poll(fn, label, timeoutMs, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}; last=${JSON.stringify(last)}`);
}

function seedBareRepo(rootDir, bareRepoPath) {
  execFileSync('git', ['init', '--bare', bareRepoPath], { stdio: 'ignore' });
  execFileSync('git', ['push', bareRepoPath, 'HEAD:refs/heads/master'], { cwd: rootDir, stdio: 'ignore' });
  try {
    execFileSync('git', ['push', bareRepoPath, 'HEAD:refs/heads/main'], { cwd: rootDir, stdio: 'ignore' });
  } catch {
    // master is enough for the repro.
  }
}

const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-forced-kill-stall-'));
const bareRepoPath = path.join(testDir, 'repo.git');
const configPath = path.join(testDir, 'e2e-config.json');
const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
const userDataDir1 = path.join(testDir, 'electron-user-data-1');
const userDataDir2 = path.join(testDir, 'electron-user-data-2');
seedBareRepo(ROOT_DIR, bareRepoPath);
writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');
REPRO_PLAN.repoUrl = pathToFileURL(bareRepoPath).href;

let app1;
let app2;
try {
  console.log('stage: launch app1');
  app1 = await launchApp(testDir, configPath, userDataDir1, ipcSocketPath);
  const page1 = await app1.firstWindow();
  await waitForInvoker(page1);
  console.log('stage: app1 ready');
  await page1.evaluate(async () => {
    await window.invoker.clear();
    await window.invoker.deleteAllWorkflows();
  });
  await loadPlan(page1, REPRO_PLAN);
  await startPlan(page1);
  console.log('stage: plan started');

  const runningTask = await poll(async () => {
    const tasks = await getTasks(page1);
    const task = findTaskByIdSuffix(tasks, 'slow-task');
    return task?.status === 'running' ? task : null;
  }, 'slow-task to enter running before kill', 15000);
  const resolvedTaskId = runningTask.id;
  console.log(`stage: task running as ${resolvedTaskId}`);

  await killElectronProcess(app1);
  app1 = undefined;
  console.log('stage: app1 force-killed');

  console.log('stage: launch app2');
  app2 = await launchApp(testDir, configPath, userDataDir2, ipcSocketPath);
  const page2 = await app2.firstWindow();
  await waitForInvoker(page2);
  console.log('stage: app2 ready');

  const runningAfterRestart = await poll(async () => {
    const tasks = await getTasks(page2);
    const task = tasks.find((candidate) => candidate.id === resolvedTaskId);
    return task?.status === 'running' ? task : null;
  }, 'task to still be running after relaunch', 5000);
  const stillRunning = await poll(async () => {
    const tasks = await getTasks(page2);
    const task = tasks.find((candidate) => candidate.id === resolvedTaskId);
    return task?.status === 'running' && !task.execution?.error ? task : null;
  }, 'task to remain running without cleanup error', 5000);
  console.log(`stage: runningAfterRestart=${Boolean(runningAfterRestart)} stillRunningWithoutError=${Boolean(stillRunning)}`);

  if (EXPECTATION === 'issue') {
    if (!runningAfterRestart || !stillRunning) {
      throw new Error('expected forced-kill repro to leave the task running after relaunch');
    }
    console.log(`issue reproduced: forced kill left ${resolvedTaskId} running after relaunch with no immediate Application quit cleanup`);
  } else {
    const notRunning = await poll(async () => {
      const tasks = await getTasks(page2);
      const task = tasks.find((candidate) => candidate.id === resolvedTaskId);
      return task && task.status !== 'running' ? task : null;
    }, 'task to avoid orphaned running state after relaunch', 10000);
    if (notRunning.status === 'running') {
      throw new Error(`expected fixed behavior, but task ${resolvedTaskId} still showed as running after relaunch`);
    }
    console.log(`fixed behavior observed: forced kill no longer leaves ${resolvedTaskId} orphaned in running state`);
  }
} finally {
  await closeApp(app1);
  await closeApp(app2);
  if (KEEP_ARTIFACTS) {
    console.log(`repro: kept temp artifacts under ${testDir}`);
  } else {
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup races from the forced-kill repro itself.
    }
  }
}
EOF

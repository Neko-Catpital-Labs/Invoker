import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL, injectTaskStates } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const TERMINAL_RESTART_PLAN = {
  name: 'Embedded terminal restart persistence',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'terminal-task',
      description: 'Completed task with terminal',
      command: 'echo unused',
      dependencies: [],
    },
  ],
};

function launchArgs(): string[] {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    MAIN_JS,
  ];
}

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

async function launchApp(paths: { dbDir: string; userDataDir: string; ipcSocketPath: string; configPath: string }): Promise<{ app: ElectronApplication; page: Page }> {
  registerTrackedBrowserUserDataDir(paths.userDataDir);
  const app = await electron.launch({
    args: [
      ...launchArgs().slice(0, -1),
      `--user-data-dir=${paths.userDataDir}`,
      MAIN_JS,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
          INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_USER_DATA_DIR: paths.userDataDir,
      INVOKER_DISABLE_SLACK: '1',
      TZ: 'UTC',
      INVOKER_GUI_OWNER_MODE: process.env.INVOKER_E2E_GUI_OWNER_MODE ?? 'gui',
      INVOKER_DB_DIR: paths.dbDir,
      INVOKER_IPC_SOCKET: paths.ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: paths.configPath,
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '10000',
      INVOKER_EMBEDDED_TERMINAL_BACKEND: 'pty',
    },
  });
  const page = await app.firstWindow();
  await waitForInvoker(page);
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  const closePromise = app.close().catch(() => undefined);
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    delay(5_000).then(() => true),
  ]);
  if (timedOut) {
    child.kill('SIGTERM');
    await Promise.race([closePromise, delay(2_000)]);
    if (!child.killed) child.kill('SIGKILL');
  }
}

async function loadPlan(page: Page): Promise<void> {
  await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(TERMINAL_RESTART_PLAN));
  await page.waitForFunction(() => window.invoker.getTasks().then((result) => {
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.some((task: { id: string }) => task.id.endsWith('/terminal-task'));
  }), null, { timeout: 10000 });
  await page.getByTestId('sidebar-planning').click();
  await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Refresh' }).click();
  await page.locator('.react-flow__node[data-testid$="terminal-task"]').first().waitFor({ state: 'visible', timeout: 10000 });
}

async function resolveFullTaskId(page: Page): Promise<string> {
  const fullTaskId = await page.evaluate(async () => {
    const result = await window.invoker.getTasks();
    const tasks = Array.isArray(result) ? result : result.tasks;
    return tasks.find((task: { id: string }) => task.id.endsWith('/terminal-task'))?.id;
  });
  if (!fullTaskId) throw new Error('terminal-task was not loaded');
  return fullTaskId;
}

async function openTerminalForTask(page: Page, taskId: string): Promise<void> {
  const taskNode = page.locator('.react-flow__node[data-testid$="terminal-task"]').first();
  const box = await taskNode.boundingBox();
  if (!box) throw new Error('terminal-task node has no bounding box');
  const target = taskNode.locator('> div');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await target.dispatchEvent('dblclick', {
      bubbles: true,
      cancelable: true,
      clientX: box.x + box.width / 2,
      clientY: box.y + box.height / 2,
    });
    await page.waitForTimeout(500);
    const sessions = await page.evaluate(() => window.invoker.terminalList());
    if (Array.isArray(sessions) && sessions.length > 0) break;
  }
  const sessions = await page.evaluate(() => window.invoker.terminalList());
  if (!Array.isArray(sessions) || sessions.length === 0) {
    const result = await page.evaluate((id) => window.invoker.openTerminal(id), taskId);
    if (!result?.opened) throw new Error(`openTerminal failed: ${result?.reason ?? 'unknown reason'}`);
  }
  await expect.poll(() => page.evaluate(() => window.invoker.terminalList().then((rows) => rows.length))).toBeGreaterThan(0);
  await expect(page.getByTestId('terminal-drawer-body')).toBeVisible({ timeout: 10000 });
}

base.describe('Embedded terminal restart persistence', () => {
  base('restores a terminal tab and accepts input after relaunch', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-terminal-restart-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await loadPlan(page);

      const workspacePath = path.join(testDir, 'terminal-workspace');
      mkdirSync(workspacePath, { recursive: true });
      await injectTaskStates(page, [
        {
          taskId: 'terminal-task',
          changes: {
            status: 'completed',
            config: { runnerKind: 'worktree' },
            execution: {
              workspacePath,
              completedAt: new Date('2025-01-01T00:00:00.000Z'),
            },
          },
        },
      ]);
      const fullTaskId = await resolveFullTaskId(page);
      await openTerminalForTask(page, fullTaskId);
      const terminalPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
      await expect(terminalPane).toBeVisible();
      await terminalPane.click();
      await page.keyboard.type('printf "before-restart-terminal-sentinel\\n"');
      await page.keyboard.press('Enter');
      await expect(terminalPane.getByText('before-restart-terminal-sentinel', { exact: true })).toBeVisible({ timeout: 10000 });

      const before = await page.evaluate(() => window.invoker.terminalList());
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ status: 'running', mode: 'spawn' });
      const sessionId = before[0].sessionId;

      await closeApp(app);
      app = undefined;
      page = undefined;
      await delay(1500);

      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      const after = await page.evaluate(() => window.invoker.terminalList());
      expect(after).toHaveLength(1);
      expect(after[0].sessionId).toBe(sessionId);
      // Terminal drawer chrome mounts only on Plan graph, not Planning home.
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('terminal-drawer')).toHaveAttribute('data-state', 'partial', { timeout: 10000 });
      await expect(page.getByTestId(`terminal-tab-${fullTaskId}`)).toBeVisible();
      const restoredPane = page.getByTestId(`terminal-pane-${fullTaskId}`);
      await expect(restoredPane.getByText('before-restart-terminal-sentinel', { exact: true })).toBeVisible({ timeout: 10000 });
      await page.screenshot({
        path: path.join(process.cwd(), 'visual-proof-terminal-restart.png'),
        fullPage: true,
      });

      await restoredPane.click();
      await page.keyboard.type('printf "after-restart-terminal-sentinel\\n"');
      await page.keyboard.press('Enter');
      await expect(restoredPane.getByText('after-restart-terminal-sentinel', { exact: true })).toBeVisible({ timeout: 10000 });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_RESTART_PLAN = {
  name: 'Planning Terminal Restart',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'update-readme',
      description: 'Update README',
      command: 'echo readme',
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
      INVOKER_EMBEDDED_TERMINAL_BACKEND: 'bash',
      INVOKER_REPO_CONFIG_PATH: paths.configPath,
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '10000',
    },
  });
  const page = await app.firstWindow();
  await waitForInvoker(page);
  return { app, page };
}

async function closeApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  let childExited = child.exitCode !== null || child.signalCode !== null;
  const childExitPromise = new Promise<void>((resolve) => {
    const markChildExited = () => {
      childExited = true;
      resolve();
    };
    child.once('exit', markChildExited);
    child.once('close', markChildExited);
  });
  const closePromise = app.close().catch(() => undefined);
  const timedOut = await Promise.race([
    closePromise.then(() => false),
    delay(5_000).then(() => true),
  ]);
  if (timedOut && !childExited) {
    child.kill('SIGTERM');
    await Promise.race([closePromise, childExitPromise, delay(2_000)]);
    if (!childExited) child.kill('SIGKILL');
  }
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-planning').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

base.describe('Planning Terminal restart persistence', () => {
  base('restores a draft-ready planning chat after relaunch', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-restart-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_RESTART_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await page.evaluate(async ({ yaml }) => {
        await window.invoker.setTestPlanningChatResponse({
          planYaml: yaml,
          planName: 'Planning Terminal Restart',
          reply: 'I drafted the restart plan.',
        });
      }, { yaml: planYaml });

      await openPlanningTerminal(page);
      await submitPlanningText(page, 'Add README');
      await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('draft ready', { timeout: 10000 });
      const savedSessionId = await page.evaluate(async () => {
        const list = await window.invoker.planningChatList();
        return list.sessions[0]?.id;
      });
      expect(savedSessionId).toBeTruthy();

      await closeApp(app);
      app = undefined;
      page = undefined;
      await delay(1500);

      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await openPlanningTerminal(page);

      await expect(page.getByTestId('invoker-terminal-transcript')).toContainText('Add README', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-transcript')).toContainText('I drafted the restart plan.');
      await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('draft ready · "Planning Terminal Restart"');
      await expect(page.getByTestId('invoker-terminal-input')).toBeEnabled();
      await expect(page.getByText('working…')).toHaveCount(0);
      const restoredSessionId = await page.evaluate(async () => {
        const list = await window.invoker.planningChatList();
        return list.sessions[0]?.id;
      });
      expect(restoredSessionId).toBe(savedSessionId);
      await page.screenshot({
        path: path.join(process.cwd(), 'visual-proof-planning-terminal-restart.png'),
        fullPage: true,
      });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('restores a tmux-mode planning terminal after relaunch', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-restart-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_RESTART_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await page.evaluate(async ({ yaml }) => {
        await window.invoker.setTestPlanningChatResponse({
          planYaml: yaml,
          planName: 'Planning Terminal Restart',
          reply: 'I drafted the restart plan.',
        });
      }, { yaml: planYaml });

      await openPlanningTerminal(page);
      await submitPlanningText(page, 'Add README');
      await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('draft ready', { timeout: 10000 });
      const savedSessionId = await page.evaluate(async () => {
        const list = await window.invoker.planningChatList();
        return list.sessions[0]?.id;
      });
      expect(savedSessionId).toBeTruthy();

      await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      const firstTerminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
      expect(firstTerminalSessionId).toBeTruthy();
      await expect.poll(async () => page!.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return {
          mode: session?.terminalMode,
          terminalSessionId: session?.terminalSessionId,
        };
      }, savedSessionId)).toEqual({
        mode: 'tmux',
        terminalSessionId: firstTerminalSessionId,
      });

      await closeApp(app);
      app = undefined;
      page = undefined;
      await delay(1500);

      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.getByTestId('sidebar-planning').click();

      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId ?? '');
      await expect.poll(async () => page!.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return {
          mode: session?.terminalMode,
          terminalSessionId: session?.terminalSessionId,
          terminalStatus: session?.terminalStatus,
        };
      }, savedSessionId)).toEqual({
        mode: 'tmux',
        terminalSessionId: firstTerminalSessionId,
        terminalStatus: 'running',
      });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

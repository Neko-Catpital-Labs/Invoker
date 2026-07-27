import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_TMUX_BLANK_REPRO_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
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
      INVOKER_EMBEDDED_TERMINAL_BACKEND: 'pty',
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
    if (!childExited) {
      child.kill('SIGKILL');
      await Promise.race([childExitPromise, delay(2_000)]);
    }
  }
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function bootstrapPlanningDraft(page: Page, planYaml: string): Promise<string> {
  await page.evaluate(async () => {
    await window.invoker.clear();
    await window.invoker.deleteAllWorkflows();
  });
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });

  await openPlanningTerminal(page);
  await submitPlanningText(page, 'Draft a YAML plan to reproduce planning tmux blanking');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });

  const sessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id;
  });
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function openActivePlanningTmux(page: Page): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  return terminalSessionId!;
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writePlanningTmuxSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const command = `printf '%s\\n' ${shellSingleQuote(sentinel)}\n`;
  await page.evaluate(async ({ sessionId, data }) => {
    const result = await window.invoker.planningTerminalWrite(sessionId, data);
    if (!result.ok) throw new Error(result.reason ?? 'planningTerminalWrite failed');
  }, { sessionId: terminalSessionId, data: command });

  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane.getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
  await expect.poll(async () => page.evaluate(async ({ sessionId, expected }) => {
    const terminals = await window.invoker.planningTerminalList();
    const terminal = terminals.find((candidate) => candidate.sessionId === sessionId);
    return terminal?.outputSnapshot?.includes(expected) ?? false;
  }, { sessionId: terminalSessionId, expected: sentinel })).toBe(true);
}

async function terminalPaneText(page: Page): Promise<string> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  return await pane.locator('.xterm-rows').evaluate((node) => node.textContent ?? '').catch(async () => (
    await pane.textContent() ?? ''
  ));
}

async function recordBlankEvidence(page: Page, testInfo: TestInfo, label: string): Promise<string> {
  const text = await terminalPaneText(page);
  await testInfo.attach(`${label}-terminal-text`, {
    body: text || '<blank terminal text>',
    contentType: 'text/plain',
  });
  await testInfo.attach(`${label}-screenshot`, {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  });
  return text;
}

async function closePlanningTerminals(page: Page | undefined): Promise<void> {
  if (!page) return;
  try {
    const terminals = await page.evaluate(async () => window.invoker.planningTerminalList());
    await Promise.all(terminals.map((terminal) => (
      page.evaluate(async (sessionId) => window.invoker.planningTerminalClose(sessionId), terminal.sessionId)
    )));
  } catch {
    // Best-effort cleanup only; keep the assertion failure as the primary signal.
  }
}

async function expectBackendSnapshotContains(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ sessionId, expected }) => {
    const terminals = await window.invoker.planningTerminalList();
    const terminal = terminals.find((candidate) => candidate.sessionId === sessionId);
    const chatList = await window.invoker.planningChatList();
    const chat = chatList.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return {
      liveTerminalHasSentinel: terminal?.outputSnapshot?.includes(expected) ?? false,
      planningChatHasSentinel: chat?.terminalOutputSnapshot?.includes(expected) ?? false,
      liveTerminalStatus: terminal?.status,
      planningChatTerminalStatus: chat?.terminalStatus,
    };
  }, { sessionId: terminalSessionId, expected: sentinel })).toEqual({
    liveTerminalHasSentinel: true,
    planningChatHasSentinel: true,
    liveTerminalStatus: 'running',
    planningChatTerminalStatus: 'running',
  });
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('reproduces blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-session-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const firstPlanningSessionId = await bootstrapPlanningDraft(page, planYaml);

      const firstTerminalSessionId = await openActivePlanningTmux(page);
      const firstSentinel = 'PLANNING_TMUX_SESSION_SWITCH_ALPHA_SENTINEL';
      await writePlanningTmuxSentinel(page, firstTerminalSessionId, firstSentinel);

      await page.getByRole('button', { name: 'New chat' }).click();
      const secondTerminalSessionId = await openActivePlanningTmux(page);
      expect(secondTerminalSessionId).not.toBe(firstTerminalSessionId);
      const secondSentinel = 'PLANNING_TMUX_SESSION_SWITCH_BETA_SENTINEL';
      await writePlanningTmuxSentinel(page, secondTerminalSessionId, secondSentinel);

      await page.getByTestId('planning-session-list').getByText('Draft a YAML plan to reproduce planning tmux blanking').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId, { timeout: 10000 });

      await expectBackendSnapshotContains(page, firstTerminalSessionId, firstSentinel);
      const postSwitchText = await recordBlankEvidence(page, testInfo, 'session-switch-back');

      expect(postSwitchText.trim()).toBe('');
      await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(firstSentinel, { exact: true })).toHaveCount(0);
      await expect.poll(async () => page.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return session?.terminalMode;
      }, firstPlanningSessionId)).toBe('tmux');
    } finally {
      await closePlanningTerminals(page);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('reproduces blank pane after navigating away from planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page, planYaml);

      const terminalSessionId = await openActivePlanningTmux(page);
      const sentinel = 'PLANNING_TMUX_NAVIGATION_BACK_SENTINEL';
      await writePlanningTmuxSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => page.evaluate(async ({ sessionId, expected }) => {
        const terminals = await window.invoker.planningTerminalList();
        const terminal = terminals.find((candidate) => candidate.sessionId === sessionId);
        return {
          status: terminal?.status,
          hasSentinel: terminal?.outputSnapshot?.includes(expected) ?? false,
        };
      }, { sessionId: terminalSessionId, expected: sentinel })).toEqual({
        status: 'running',
        hasSentinel: true,
      });

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });

      await expectBackendSnapshotContains(page, terminalSessionId, sentinel);
      const postNavigationText = await recordBlankEvidence(page, testInfo, 'navigation-back');

      expect(postNavigationText.trim()).toBe('');
      await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toHaveCount(0);
      await expect.poll(async () => page.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return {
          mode: session?.terminalMode,
          terminalStatus: session?.terminalStatus,
        };
      }, planningSessionId)).toEqual({
        mode: 'tmux',
        terminalStatus: 'running',
      });
    } finally {
      await closePlanningTerminals(page);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

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
  const childExitPromise = childExited
    ? Promise.resolve()
    : new Promise<void>((resolve) => {
      const markChildExited = () => {
        childExited = true;
        resolve();
      };
      child.once('exit', markChildExited);
      child.once('close', markChildExited);
    });
  const closePromise = app.close().catch(() => undefined);
  const timedOut = await Promise.race([
    Promise.all([closePromise, childExitPromise]).then(() => false),
    delay(5_000).then(() => true),
  ]);
  if (timedOut && !childExited) {
    child.kill('SIGTERM');
    await Promise.race([closePromise, childExitPromise, delay(2_000)]);
    if (!childExited) child.kill('SIGKILL');
  }
  if (!childExited) {
    await Promise.race([childExitPromise, delay(2_000)]);
  }
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByText('Planning chat')).toBeVisible({ timeout: 10000 });
}

async function bootstrapPlanningSessions(page: Page, titles: string[]): Promise<string[]> {
  const sessionIds = await page.evaluate(async (sessionTitles) => {
    await window.invoker.clear();
    await window.invoker.deleteAllWorkflows();

    const createdIds: string[] = [];
    for (const title of sessionTitles) {
      const result = await window.invoker.planningChatCreate({ title });
      if (!result.ok) throw new Error(result.error);
      createdIds.push(result.session.id);
    }
    return createdIds;
  }, titles);

  await page.reload();
  await waitForInvoker(page);
  await openPlanningTerminal(page);
  await expect(page.getByTestId('planning-session-list')).toContainText(titles[0], { timeout: 10000 });
  await expect(page.getByTestId('planning-session-list')).toContainText(titles[1], { timeout: 10000 });
  return sessionIds;
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('planning-session-list').getByText(title, { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Planning chat' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByText(title).first()).toBeVisible({ timeout: 10000 });
}

async function openTmuxForPlanningSession(page: Page, planningSessionId: string): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });

  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return {
      mode: session?.terminalMode,
      terminalSessionId: session?.terminalSessionId,
      terminalStatus: session?.terminalStatus,
    };
  }, planningSessionId)).toEqual({
    mode: 'tmux',
    terminalSessionId,
    terminalStatus: 'running',
  });
  return terminalSessionId ?? '';
}

async function writePlanningTerminalCommand(page: Page, terminalSessionId: string, command: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, input }) => (
    window.invoker.planningTerminalWrite(sessionId, `${input}\n`)
  ), { sessionId: terminalSessionId, input: command });
  expect(result).toMatchObject({ ok: true });
}

async function waitForTerminalSnapshot(page: Page, planningSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ sessionId, text }) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return session?.terminalOutputSnapshot?.includes(text) ?? false;
  }, { sessionId: planningSessionId, text: sentinel }), {
    message: `terminal output snapshot should contain ${sentinel}`,
    timeout: 10000,
  }).toBe(true);
}

async function waitForVisibleTerminalText(page: Page, sentinel: string): Promise<void> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function renderedTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => (
    (element as HTMLElement).innerText || element.textContent || ''
  ));
}

async function captureTerminalEvidence(page: Page, testInfo: TestInfo, label: string): Promise<string> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const text = await renderedTerminalText(page);
  const textPath = testInfo.outputPath(`${label}.txt`);
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  writeFileSync(textPath, text, 'utf8');
  await pane.screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-text`, { path: textPath, contentType: 'text/plain' });
  await testInfo.attach(`${label}-screenshot`, { path: screenshotPath, contentType: 'image/png' });
  return text;
}

async function closePlanningTerminalSessions(page: Page | undefined): Promise<void> {
  if (!page || page.isClosed()) return;
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  });
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank tmux pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const firstTitle = 'Tmux blank repro alpha';
      const secondTitle = 'Tmux blank repro beta';
      const firstSentinel = 'PLANNING_TMUX_REPRO_ALPHA_SENTINEL';
      const secondSentinel = 'PLANNING_TMUX_REPRO_BETA_SENTINEL';

      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const [firstPlanningSessionId, secondPlanningSessionId] = await bootstrapPlanningSessions(page, [firstTitle, secondTitle]);

      await selectPlanningSession(page, firstTitle);
      const firstTerminalSessionId = await openTmuxForPlanningSession(page, firstPlanningSessionId);
      await writePlanningTerminalCommand(page, firstTerminalSessionId, `printf '${firstSentinel}\\n'`);
      await waitForVisibleTerminalText(page, firstSentinel);
      await waitForTerminalSnapshot(page, firstPlanningSessionId, firstSentinel);

      await selectPlanningSession(page, secondTitle);
      const secondTerminalSessionId = await openTmuxForPlanningSession(page, secondPlanningSessionId);
      await writePlanningTerminalCommand(page, secondTerminalSessionId, `printf '${secondSentinel}\\n'`);
      await waitForVisibleTerminalText(page, secondSentinel);
      await waitForTerminalSnapshot(page, secondPlanningSessionId, secondSentinel);

      await selectPlanningSession(page, firstTitle);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId);
      await waitForTerminalSnapshot(page, firstPlanningSessionId, firstSentinel);

      const postSwitchText = await captureTerminalEvidence(page, testInfo, 'post-session-switch-back');
      // Repro slice: the backing session still has output, but the remounted pane is blank.
      expect(postSwitchText.trim()).toBe('');
      expect(postSwitchText).not.toContain(firstSentinel);
    } finally {
      await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank tmux pane after navigating away from Planning Terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-route-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const title = 'Tmux blank repro route';
      const sentinel = 'PLANNING_TMUX_REPRO_ROUTE_SENTINEL';

      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const [planningSessionId] = await bootstrapPlanningSessions(page, [title, 'Tmux blank repro spare']);

      await selectPlanningSession(page, title);
      const terminalSessionId = await openTmuxForPlanningSession(page, planningSessionId);
      await writePlanningTerminalCommand(page, terminalSessionId, `printf '${sentinel}\\n'`);
      await waitForVisibleTerminalText(page, sentinel);
      await waitForTerminalSnapshot(page, planningSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      await waitForTerminalSnapshot(page, planningSessionId, sentinel);

      const postRouteText = await captureTerminalEvidence(page, testInfo, 'post-route-return');
      // Repro slice: the backing session still has output, but the remounted pane is blank.
      expect(postRouteText.trim()).toBe('');
      expect(postRouteText).not.toContain(sentinel);
    } finally {
      await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

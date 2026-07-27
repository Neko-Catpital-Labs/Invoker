import { test as base, _electron as electron, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_TMUX_BLANK_REPRO_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'record-tmux-blank-repro',
      description: 'Record planning terminal tmux blank repro',
      command: 'echo repro',
      dependencies: [],
    },
  ],
};

type TestPaths = {
  dbDir: string;
  userDataDir: string;
  ipcSocketPath: string;
  configPath: string;
};

type TerminalTextEvidence = {
  label: string;
  sessionId: string;
  sentinel: string;
  rowsText: string;
  normalizedRowsText: string;
  fullText: string;
  normalizedFullText: string;
  terminalSessions: unknown;
  planningChatSessions: unknown;
};

function launchArgs(): string[] {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    MAIN_JS,
  ];
}

function makeTestPaths(prefix: string): TestPaths & { testDir: string } {
  const testDir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    testDir,
    dbDir: testDir,
    userDataDir: path.join(testDir, 'electron-user-data'),
    ipcSocketPath: path.join(testDir, 'ipc-transport.sock'),
    configPath: path.join(testDir, 'e2e-config.json'),
  };
}

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

async function launchApp(paths: TestPaths): Promise<{ app: ElectronApplication; page: Page }> {
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
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function configurePlanningResponse(page: Page): Promise<void> {
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });
}

async function createPlanningSessionFromPrompt(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  const transcript = page.getByTestId('invoker-terminal-transcript');
  await expect(transcript).toContainText(prompt, { timeout: 10000 });
  await expect(transcript).toContainText('I drafted the tmux blank repro plan.', { timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (message) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => (
      session.messages.some((line) => line.role === 'user' && line.text === message)
    ))?.id ?? null;
  }, prompt);
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function openActiveTmuxPane(page: Page): Promise<{ pane: Locator; sessionId: string }> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  return { pane, sessionId: sessionId! };
}

async function writePlanningTerminalCommand(page: Page, sessionId: string, command: string): Promise<void> {
  const result = await page.evaluate(async ({ id, data }) => {
    return window.invoker.planningTerminalWrite(id, data);
  }, { id: sessionId, data: `${command}\n` });
  expect(result).toMatchObject({ ok: true });
}

async function writeSentinelOutput(page: Page, pane: Locator, sessionId: string, sentinel: string): Promise<void> {
  await writePlanningTerminalCommand(page, sessionId, `printf '%s\\n' '${sentinel}'`);
  await expect(pane.getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForPersistedTerminalSnapshot(page: Page, planningSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => {
    const list = await page.evaluate(async () => window.invoker.planningChatList());
    const session = list.sessions.find((candidate) => candidate.id === planningSessionId);
    return session?.terminalOutputSnapshot ?? '';
  }, { timeout: 10000 }).toContain(sentinel);
}

async function captureTerminalEvidence(
  page: Page,
  pane: Locator,
  testInfo: TestInfo,
  label: string,
  sessionId: string,
  sentinel: string,
): Promise<TerminalTextEvidence> {
  const text = await pane.evaluate((element) => {
    const rows = Array.from(element.querySelectorAll('.xterm-rows > div')).map((row) => row.textContent ?? '');
    return {
      rowsText: rows.join('\n'),
      fullText: element.textContent ?? '',
    };
  });
  const [terminalSessions, planningChatSessions] = await Promise.all([
    page.evaluate(async () => window.invoker.planningTerminalList()),
    page.evaluate(async () => window.invoker.planningChatList()),
  ]);
  const evidence: TerminalTextEvidence = {
    label,
    sessionId,
    sentinel,
    rowsText: text.rowsText,
    normalizedRowsText: normalizeTerminalText(text.rowsText),
    fullText: text.fullText,
    normalizedFullText: normalizeTerminalText(text.fullText),
    terminalSessions,
    planningChatSessions,
  };
  await testInfo.attach(`${label}-terminal-text.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${label}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return evidence;
}

async function expectBuggyBlankPane(
  page: Page,
  pane: Locator,
  testInfo: TestInfo,
  label: string,
  sessionId: string,
  sentinel: string,
): Promise<void> {
  await page.waitForTimeout(500);
  const evidence = await captureTerminalEvidence(page, pane, testInfo, label, sessionId, sentinel);
  const message = JSON.stringify({
    label,
    sessionId,
    sentinel,
    normalizedRowsText: evidence.normalizedRowsText,
    normalizedFullText: evidence.normalizedFullText,
  }, null, 2);
  expect(evidence.normalizedRowsText, message).toBe('');
  expect(evidence.fullText, message).not.toContain(sentinel);
}

function planningSessionButton(page: Page, title: string): Locator {
  return page.getByTestId('planning-session-list').getByRole('button', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) });
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records the current blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const paths = makeTestPaths('invoker-e2e-planning-tmux-session-switch-');
    writeFileSync(paths.configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launch = await launchApp(paths);
      app = launch.app;
      const { page } = launch;
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await configurePlanningResponse(page);

      await openPlanningTerminal(page);
      const alphaPrompt = 'Draft a YAML plan for Alpha tmux repro';
      const betaPrompt = 'Draft a YAML plan for Beta tmux repro';
      const alphaSentinel = '__INVOKER_TMUX_ALPHA_SENTINEL__';
      const betaSentinel = '__INVOKER_TMUX_BETA_SENTINEL__';
      const alphaPlanningSessionId = await createPlanningSessionFromPrompt(page, alphaPrompt);
      const alpha = await openActiveTmuxPane(page);
      await writeSentinelOutput(page, alpha.pane, alpha.sessionId, alphaSentinel);
      await waitForPersistedTerminalSnapshot(page, alphaPlanningSessionId, alphaSentinel);

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible();
      await createPlanningSessionFromPrompt(page, betaPrompt);
      const beta = await openActiveTmuxPane(page);
      await writeSentinelOutput(page, beta.pane, beta.sessionId, betaSentinel);

      await planningSessionButton(page, alphaPrompt).click();
      const restoredAlphaPane = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(restoredAlphaPane).toHaveAttribute('data-session-id', alpha.sessionId, { timeout: 10000 });
      await expect(restoredAlphaPane.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
      await waitForPersistedTerminalSnapshot(page, alphaPlanningSessionId, alphaSentinel);

      // Repro assertion: the backing planning terminal still has the sentinel,
      // but the remounted xterm pane is currently visually blank.
      await expectBuggyBlankPane(
        page,
        restoredAlphaPane,
        testInfo,
        'planning-terminal-tmux-session-switch-blank-repro',
        alpha.sessionId,
        alphaSentinel,
      );
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  });

  base('records the current blank pane after leaving planning terminal and returning', async ({}, testInfo) => {
    const paths = makeTestPaths('invoker-e2e-planning-tmux-navigation-');
    writeFileSync(paths.configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launch = await launchApp(paths);
      app = launch.app;
      const { page } = launch;
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await configurePlanningResponse(page);

      await openPlanningTerminal(page);
      const prompt = 'Draft a YAML plan for Navigation tmux repro';
      const sentinel = '__INVOKER_TMUX_NAVIGATION_SENTINEL__';
      const planningSessionId = await createPlanningSessionFromPrompt(page, prompt);
      const terminal = await openActiveTmuxPane(page);
      await writeSentinelOutput(page, terminal.pane, terminal.sessionId, sentinel);
      await waitForPersistedTerminalSnapshot(page, planningSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await expect.poll(async () => {
        const sessions = await page.evaluate(async () => window.invoker.planningTerminalList());
        return sessions.find((session) => session.sessionId === terminal.sessionId)?.status;
      }, { timeout: 10000 }).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByRole('heading', { name: 'Planning chat' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      const restoredPane = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(restoredPane).toHaveAttribute('data-session-id', terminal.sessionId, { timeout: 10000 });
      await expect(restoredPane.locator('.xterm-rows')).toBeVisible({ timeout: 10000 });
      await waitForPersistedTerminalSnapshot(page, planningSessionId, sentinel);

      // Repro assertion: route navigation remounts the still-running planning
      // tmux session with no visible xterm rows.
      await expectBuggyBlankPane(
        page,
        restoredPane,
        testInfo,
        'planning-terminal-tmux-navigation-blank-repro',
        terminal.sessionId,
        sentinel,
      );
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  });
});

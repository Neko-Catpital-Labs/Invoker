import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      id: 'record-tmux-blank-repro',
      description: 'Record tmux blank repro',
      command: 'echo tmux-blank-repro',
      dependencies: [],
    },
  ],
};

const ALPHA_PROMPT = 'Draft alpha planning tmux blank repro plan';
const ALPHA_SENTINEL = 'PLANNING_TMUX_ALPHA_SENTINEL_9B4E43';
const BETA_SENTINEL = 'PLANNING_TMUX_BETA_SENTINEL_2A5C17';

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
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function primeAppForPlanningRepro(page: Page, planYaml: string): Promise<void> {
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
}

async function createDraftReadyPlanningSession(page: Page, prompt: string): Promise<string> {
  await openPlanningTerminal(page);
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function switchActivePlanningSessionToTmux(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  return terminalSessionId!;
}

async function writeSentinelToPlanningTerminal(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, command }) => {
    return window.invoker.planningTerminalWrite(sessionId, command);
  }, {
    sessionId: terminalSessionId,
    command: `printf '\\033[2J\\033[H${sentinel}\\n'\n`,
  });
  expect(result.ok, result.reason).toBe(true);
}

async function terminalPaneText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    return rows?.textContent ?? element.textContent ?? '';
  });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForVisibleSentinel(page: Page, sentinel: string): Promise<void> {
  await expect.poll(
    async () => normalizeTerminalText(await terminalPaneText(page)),
    { timeout: 10000 },
  ).toContain(sentinel);
}

async function persistedPlanningSnapshot(page: Page, planningSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.id === sessionId)?.terminalOutputSnapshot ?? '';
  }, planningSessionId);
}

async function waitForPersistedSentinel(page: Page, planningSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(
    async () => persistedPlanningSnapshot(page, planningSessionId),
    { timeout: 10000 },
  ).toContain(sentinel);
}

async function planningTerminalStatus(page: Page, terminalSessionId: string): Promise<string | null> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningTerminalList();
    return list.find((session) => session.sessionId === sessionId)?.status ?? null;
  }, terminalSessionId);
}

async function recordBlankEvidence(
  testInfo: TestInfo,
  page: Page,
  opts: {
    label: string;
    planningSessionId: string;
    terminalSessionId: string;
    sentinel: string;
  },
): Promise<{
  visibleText: string;
  normalizedVisibleText: string;
  persistedSnapshot: string;
  terminalStatus: string | null;
}> {
  const screenshotPath = testInfo.outputPath(`${opts.label}.png`);
  const evidencePath = testInfo.outputPath(`${opts.label}.json`);
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.getByTestId('invoker-terminal-tmux-pane').screenshot({ path: screenshotPath });

  const visibleText = await terminalPaneText(page);
  const normalizedVisibleText = normalizeTerminalText(visibleText);
  const persistedSnapshot = await persistedPlanningSnapshot(page, opts.planningSessionId);
  const terminalStatus = await planningTerminalStatus(page, opts.terminalSessionId);
  const evidence = {
    label: opts.label,
    sentinel: opts.sentinel,
    planningSessionId: opts.planningSessionId,
    terminalSessionId: opts.terminalSessionId,
    terminalStatus,
    currentlyBuggyExpectation: 'post-switch xterm pane is blank even though the planning terminal session is still running and its persisted snapshot contains the sentinel',
    visibleText,
    normalizedVisibleText,
    visibleTextIncludesSentinel: visibleText.includes(opts.sentinel),
    persistedSnapshotIncludesSentinel: persistedSnapshot.includes(opts.sentinel),
    persistedSnapshotTail: persistedSnapshot.slice(-500),
  };
  writeFileSync(evidencePath, JSON.stringify(evidence, null, 2), 'utf8');
  await testInfo.attach(`${opts.label}-terminal-pane`, { path: screenshotPath, contentType: 'image/png' });
  await testInfo.attach(`${opts.label}-evidence`, { path: evidencePath, contentType: 'application/json' });
  return { visibleText, normalizedVisibleText, persistedSnapshot, terminalStatus };
}

function prepareIsolatedPaths(prefix: string): { testDir: string; configPath: string; userDataDir: string; ipcSocketPath: string } {
  const testDir = mkdtempSync(path.join(tmpdir(), prefix));
  return {
    testDir,
    configPath: path.join(testDir, 'e2e-config.json'),
    userDataDir: path.join(testDir, 'electron-user-data'),
    ipcSocketPath: path.join(testDir, 'ipc-transport.sock'),
  };
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const paths = prepareIsolatedPaths('invoker-e2e-planning-tmux-switch-blank-');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(paths.configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({
        dbDir: paths.testDir,
        userDataDir: paths.userDataDir,
        ipcSocketPath: paths.ipcSocketPath,
        configPath: paths.configPath,
      });
      app = launched.app;
      const page = launched.page;
      await primeAppForPlanningRepro(page, planYaml);

      const alphaPlanningSessionId = await createDraftReadyPlanningSession(page, ALPHA_PROMPT);
      const alphaTerminalSessionId = await switchActivePlanningSessionToTmux(page);
      await writeSentinelToPlanningTerminal(page, alphaTerminalSessionId, ALPHA_SENTINEL);
      await waitForVisibleSentinel(page, ALPHA_SENTINEL);
      await waitForPersistedSentinel(page, alphaPlanningSessionId, ALPHA_SENTINEL);

      await page.getByRole('button', { name: 'New chat' }).click();
      await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      const betaTerminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
      expect(betaTerminalSessionId).toBeTruthy();
      expect(betaTerminalSessionId).not.toBe(alphaTerminalSessionId);
      await writeSentinelToPlanningTerminal(page, betaTerminalSessionId!, BETA_SENTINEL);
      await waitForVisibleSentinel(page, BETA_SENTINEL);

      await page.getByTestId('planning-session-list').getByText(ALPHA_PROMPT, { exact: false }).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible();

      const evidence = await recordBlankEvidence(testInfo, page, {
        label: 'planning-tmux-session-switch-blank',
        planningSessionId: alphaPlanningSessionId,
        terminalSessionId: alphaTerminalSessionId,
        sentinel: ALPHA_SENTINEL,
      });
      expect(evidence.terminalStatus).toBe('running');
      expect(evidence.persistedSnapshot).toContain(ALPHA_SENTINEL);
      expect(evidence.normalizedVisibleText).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  });

  base('records blank pane after navigating away and back while planning tmux stays active', async ({}, testInfo) => {
    const paths = prepareIsolatedPaths('invoker-e2e-planning-tmux-nav-blank-');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(paths.configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({
        dbDir: paths.testDir,
        userDataDir: paths.userDataDir,
        ipcSocketPath: paths.ipcSocketPath,
        configPath: paths.configPath,
      });
      app = launched.app;
      const page = launched.page;
      await primeAppForPlanningRepro(page, planYaml);

      const planningSessionId = await createDraftReadyPlanningSession(page, ALPHA_PROMPT);
      const terminalSessionId = await switchActivePlanningSessionToTmux(page);
      await writeSentinelToPlanningTerminal(page, terminalSessionId, ALPHA_SENTINEL);
      await waitForVisibleSentinel(page, ALPHA_SENTINEL);
      await waitForPersistedSentinel(page, planningSessionId, ALPHA_SENTINEL);

      await page.getByTestId('sidebar-workers').click();
      await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: 10000 });
      expect(await planningTerminalStatus(page, terminalSessionId)).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible();

      const evidence = await recordBlankEvidence(testInfo, page, {
        label: 'planning-tmux-navigation-return-blank',
        planningSessionId,
        terminalSessionId,
        sentinel: ALPHA_SENTINEL,
      });
      expect(evidence.terminalStatus).toBe('running');
      expect(evidence.persistedSnapshot).toContain(ALPHA_SENTINEL);
      expect(evidence.normalizedVisibleText).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(paths.testDir, { recursive: true, force: true });
    }
  });
});

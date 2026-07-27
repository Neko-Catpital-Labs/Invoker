import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_TMUX_BLANK_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Capture planning terminal tmux blank repro',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

const ALPHA_TITLE = 'Draft a YAML plan for tmux alpha blank repro';
const BETA_TITLE = 'Draft a YAML plan for tmux beta blank repro';
const ALPHA_SENTINEL = 'PLANNING_TMUX_ALPHA_SENTINEL_REPRO';
const BETA_SENTINEL = 'PLANNING_TMUX_BETA_SENTINEL_REPRO';

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

async function bootstrapPlanningBlankRepro(page: Page): Promise<void> {
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
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

async function createDraftPlanningSession(page: Page, title: string): Promise<string> {
  await submitPlanningText(page, title);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (sessionTitle) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.title === sessionTitle)?.id ?? null;
  }, title);
  expect(sessionId).toBeTruthy();
  return sessionId as string;
}

async function createNewPlanningChat(page: Page): Promise<void> {
  await page.getByTestId('planning-session-rail').getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-input')).toHaveValue('');
}

async function openTmuxForActiveSession(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expectPlanningTerminalRunning(page, sessionId as string);
  return sessionId as string;
}

async function expectPlanningTerminalRunning(page: Page, terminalSessionId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningTerminalList?.();
    return list?.find((session) => session.sessionId === sessionId)?.status ?? null;
  }, terminalSessionId)).toBe('running');
}

async function writeSentinelToActiveTmuxPane(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, text }) => (
    window.invoker.planningTerminalWrite?.(sessionId, `printf '${text}\\n'\n`)
  ), { sessionId: terminalSessionId, text: sentinel });
  expect(result).toMatchObject({ ok: true });

  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
  await expect(pane.getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function selectPlanningSession(page: Page, title: string, terminalSessionId: string): Promise<void> {
  await page.getByTestId('planning-session-list').locator('button').filter({ hasText: title }).first().click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
}

async function readVisibleTmuxText(page: Page): Promise<string> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  return pane.evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    const rawText = rows?.textContent ?? element.textContent ?? '';
    return rawText.replace(/\u00a0/g, ' ').trim();
  });
}

async function recordPostSwitchEvidence(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  await page.waitForTimeout(500);
  const text = await readVisibleTmuxText(page);
  const textPath = testInfo.outputPath(`${name}.txt`);
  writeFileSync(textPath, text || '<blank>', 'utf8');
  await testInfo.attach(`${name}-terminal-text`, {
    path: textPath,
    contentType: 'text/plain',
  });
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${name}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return text;
}

function expectCurrentBlankBug(text: string, sentinel: string): void {
  expect(text, 'current repro expectation: remounted planning tmux pane is visibly blank').toBe('');
  expect(text, 'current repro expectation: persisted tmux output is not replayed into the remounted pane').not.toContain(sentinel);
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records the current blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      await bootstrapPlanningBlankRepro(page);

      await openPlanningTerminal(page);
      const alphaPlanningSessionId = await createDraftPlanningSession(page, ALPHA_TITLE);
      const alphaTerminalSessionId = await openTmuxForActiveSession(page);
      await writeSentinelToActiveTmuxPane(page, alphaTerminalSessionId, ALPHA_SENTINEL);

      await createNewPlanningChat(page);
      const betaPlanningSessionId = await createDraftPlanningSession(page, BETA_TITLE);
      const betaTerminalSessionId = await openTmuxForActiveSession(page);
      await writeSentinelToActiveTmuxPane(page, betaTerminalSessionId, BETA_SENTINEL);

      await selectPlanningSession(page, ALPHA_TITLE, alphaTerminalSessionId);
      await expectPlanningTerminalRunning(page, alphaTerminalSessionId);
      const alphaPostSwitchText = await recordPostSwitchEvidence(page, testInfo, 'switch-to-alpha-blank');
      expectCurrentBlankBug(alphaPostSwitchText, ALPHA_SENTINEL);

      await selectPlanningSession(page, BETA_TITLE, betaTerminalSessionId);
      await expectPlanningTerminalRunning(page, betaTerminalSessionId);
      const betaPostSwitchBackText = await recordPostSwitchEvidence(page, testInfo, 'switch-back-to-beta-blank');
      expectCurrentBlankBug(betaPostSwitchBackText, BETA_SENTINEL);

      await expect.poll(async () => page.evaluate(async ({ alphaId, betaId }) => {
        const list = await window.invoker.planningChatList();
        return list.sessions
          .filter((session) => session.id === alphaId || session.id === betaId)
          .map((session) => ({
            id: session.id,
            mode: session.terminalMode,
            terminalSessionId: session.terminalSessionId,
            terminalStatus: session.terminalStatus,
          }))
          .sort((left, right) => left.id.localeCompare(right.id));
      }, { alphaId: alphaPlanningSessionId, betaId: betaPlanningSessionId })).toEqual([
        {
          id: alphaPlanningSessionId,
          mode: 'tmux',
          terminalSessionId: alphaTerminalSessionId,
          terminalStatus: 'running',
        },
        {
          id: betaPlanningSessionId,
          mode: 'tmux',
          terminalSessionId: betaTerminalSessionId,
          terminalStatus: 'running',
        },
      ].sort((left, right) => left.id.localeCompare(right.id)));
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the current blank pane after navigating away from an active planning tmux session and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      await bootstrapPlanningBlankRepro(page);

      await openPlanningTerminal(page);
      const planningSessionId = await createDraftPlanningSession(page, ALPHA_TITLE);
      const terminalSessionId = await openTmuxForActiveSession(page);
      await writeSentinelToActiveTmuxPane(page, terminalSessionId, ALPHA_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('sidebar-planning')).toHaveAttribute('aria-current', 'page', { timeout: 10000 });
      await expectPlanningTerminalRunning(page, terminalSessionId);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      const postNavigationText = await recordPostSwitchEvidence(page, testInfo, 'navigate-away-and-back-blank');
      expectCurrentBlankBug(postNavigationText, ALPHA_SENTINEL);

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
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

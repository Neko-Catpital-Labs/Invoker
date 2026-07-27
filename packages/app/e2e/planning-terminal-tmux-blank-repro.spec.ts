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
      id: 'tmux-blank-repro',
      description: 'Capture planning terminal tmux blank repro',
      command: 'echo tmux blank repro',
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
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function draftPlanningSession(page: Page, title: string): Promise<string> {
  await submitPlanningText(page, title);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  return planningSessionIdByTitle(page, title);
}

async function planningSessionIdByTitle(page: Page, title: string): Promise<string> {
  await page.waitForFunction(async (targetTitle) => {
    const list = await window.invoker.planningChatList();
    return list.ok && list.sessions.some((session) => session.title === targetTitle);
  }, title, { timeout: 10000 });
  const sessionId = await page.evaluate(async (targetTitle) => {
    const list = await window.invoker.planningChatList();
    return list.ok
      ? list.sessions.find((session) => session.title === targetTitle)?.id ?? null
      : null;
  }, title);
  if (!sessionId) throw new Error(`Planning session not found for title "${title}".`);
  return sessionId;
}

async function openTmuxForActivePlanningSession(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const sessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane did not expose a terminal session id.');
  await expect.poll(async () => page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === id)?.status ?? null;
  }, sessionId), { timeout: 10000 }).toBe('running');
  return sessionId;
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, data }) => {
    return window.invoker.planningTerminalWrite(sessionId, data);
  }, {
    sessionId: terminalSessionId,
    data: `printf "${sentinel}\\n"\n`,
  });
  expect(result, `planningTerminalWrite failed for ${terminalSessionId}`).toMatchObject({ ok: true });
}

async function waitForLiveSentinel(page: Page, sentinel: string): Promise<void> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function waitForPersistedSentinel(page: Page, planningSessionId: string, sentinel: string): Promise<string> {
  await expect.poll(async () => page.evaluate(async ({ sessionId }) => {
    const list = await window.invoker.planningChatList();
    if (!list.ok) return '';
    return list.sessions.find((session) => session.id === sessionId)?.terminalOutputSnapshot ?? '';
  }, { sessionId: planningSessionId }), { timeout: 10000 }).toContain(sentinel);
  return page.evaluate(async ({ sessionId }) => {
    const list = await window.invoker.planningChatList();
    if (!list.ok) return '';
    return list.sessions.find((session) => session.id === sessionId)?.terminalOutputSnapshot ?? '';
  }, { sessionId: planningSessionId });
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('planning-session-list')
    .getByRole('button')
    .filter({ hasText: title })
    .first()
    .click();
}

async function waitForPaneSession(page: Page, terminalSessionId: string): Promise<void> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
}

async function expectPlanningTerminalRunning(page: Page, terminalSessionId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === id)?.status ?? null;
  }, terminalSessionId), { timeout: 10000 }).toBe('running');
}

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  sentinel: string,
  extra: Record<string, unknown>,
): Promise<{ normalizedText: string; screenshotPath: string }> {
  await page.waitForTimeout(500);
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  const rawText = await pane.innerText();
  const normalizedText = rawText.replace(/\u00a0/g, ' ').trim();
  const screenshotPath = path.join(process.cwd(), `visual-proof-${name}.png`);
  await pane.screenshot({ path: screenshotPath });
  const evidence = {
    ...extra,
    sentinel,
    containsSentinel: rawText.includes(sentinel),
    normalizedText,
    rawTextLength: rawText.length,
    screenshotPath,
  };
  const evidenceJson = JSON.stringify(evidence, null, 2);
  console.log(`PLANNING_TMUX_BLANK_REPRO_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}=${JSON.stringify(evidence)}`);
  await testInfo.attach(`${name}-blank-evidence`, {
    body: evidenceJson,
    contentType: 'application/json',
  });
  await testInfo.attach(`${name}-blank-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  expect(rawText.includes(sentinel), evidenceJson).toBe(false);
  expect(normalizedText, evidenceJson).toBe('');
  return { normalizedText, screenshotPath };
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records currently blank tmux pane after session and view switches', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
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
          planName: 'Planning Terminal Tmux Blank Repro',
          reply: 'I drafted the tmux blank repro plan.',
        });
      }, { yaml: planYaml });

      const alphaTitle = 'Draft a YAML plan alpha tmux repro';
      const betaTitle = 'Draft a YAML plan beta tmux repro';
      const alphaSwitchSentinel = 'TMUX_BLANK_REPRO_ALPHA_SWITCH';
      const betaSentinel = 'TMUX_BLANK_REPRO_BETA';
      const alphaNavigationSentinel = 'TMUX_BLANK_REPRO_ALPHA_NAVIGATION';

      await openPlanningTerminal(page);
      const alphaPlanningSessionId = await draftPlanningSession(page, alphaTitle);
      const alphaTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeSentinel(page, alphaTerminalSessionId, alphaSwitchSentinel);
      await waitForLiveSentinel(page, alphaSwitchSentinel);
      const alphaSwitchSnapshot = await waitForPersistedSentinel(page, alphaPlanningSessionId, alphaSwitchSentinel);

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      const betaPlanningSessionId = await draftPlanningSession(page, betaTitle);
      const betaTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeSentinel(page, betaTerminalSessionId, betaSentinel);
      await waitForLiveSentinel(page, betaSentinel);
      const betaSnapshot = await waitForPersistedSentinel(page, betaPlanningSessionId, betaSentinel);

      await selectPlanningSession(page, alphaTitle);
      await waitForPaneSession(page, alphaTerminalSessionId);
      await expectPlanningTerminalRunning(page, alphaTerminalSessionId);
      await waitForPersistedSentinel(page, alphaPlanningSessionId, alphaSwitchSentinel);
      await captureBlankEvidence(page, testInfo, 'planning-terminal-tmux-blank-session-switch', alphaSwitchSentinel, {
        switchPath: 'planning-session-list',
        alphaPlanningSessionId,
        alphaTerminalSessionId,
        betaPlanningSessionId,
        betaTerminalSessionId,
        alphaSwitchSnapshotIncludesSentinel: alphaSwitchSnapshot.includes(alphaSwitchSentinel),
        betaSnapshotIncludesSentinel: betaSnapshot.includes(betaSentinel),
      });

      await writeSentinel(page, alphaTerminalSessionId, alphaNavigationSentinel);
      await waitForLiveSentinel(page, alphaNavigationSentinel);
      const alphaNavigationSnapshot = await waitForPersistedSentinel(page, alphaPlanningSessionId, alphaNavigationSentinel);

      await page.getByTestId('sidebar-planning').click();
      await expectPlanningTerminalRunning(page, alphaTerminalSessionId);
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await waitForPaneSession(page, alphaTerminalSessionId);
      await expectPlanningTerminalRunning(page, alphaTerminalSessionId);
      await waitForPersistedSentinel(page, alphaPlanningSessionId, alphaNavigationSentinel);
      await captureBlankEvidence(page, testInfo, 'planning-terminal-tmux-blank-navigation', alphaNavigationSentinel, {
        switchPath: 'sidebar-planning-to-sidebar-home',
        alphaPlanningSessionId,
        alphaTerminalSessionId,
        alphaNavigationSnapshotIncludesSentinel: alphaNavigationSnapshot.includes(alphaNavigationSentinel),
      });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

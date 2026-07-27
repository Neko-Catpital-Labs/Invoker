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
      id: 'observe-terminal-blanking',
      description: 'Observe planning terminal tmux blanking',
      command: 'echo observe terminal blanking',
      dependencies: [],
    },
  ],
};

const SWITCH_ALPHA_PROMPT = 'Draft alpha tmux blank repro plan';
const SWITCH_BETA_PROMPT = 'Draft beta tmux blank repro plan';
const SWITCH_ALPHA_SENTINEL = 'PLANNING_TMUX_SWITCH_ALPHA_SENTINEL';
const SWITCH_BETA_SENTINEL = 'PLANNING_TMUX_SWITCH_BETA_SENTINEL';
const NAV_PROMPT = 'Draft navigation tmux blank repro plan';
const NAV_SENTINEL = 'PLANNING_TMUX_NAV_SENTINEL';

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

async function installPlanningResponse(page: Page, planYaml: string): Promise<void> {
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });
}

async function submitDraftPrompt(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  return resolvePlanningSessionIdByPrompt(page, prompt);
}

async function resolvePlanningSessionIdByPrompt(page: Page, prompt: string): Promise<string> {
  const sessionId = await page.evaluate(async (targetPrompt) => {
    const list = await window.invoker.planningChatList();
    if (!list.ok) return null;
    return list.sessions.find((session) => (
      session.messages.some((message) => message.role === 'user' && message.text === targetPrompt)
    ))?.id ?? null;
  }, prompt);
  if (!sessionId) throw new Error(`Planning session for prompt "${prompt}" was not found`);
  return sessionId;
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('planning-session-list').locator('button', { hasText: title }).first().click();
}

async function openPlanningTmux(page: Page, planningSessionId: string): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.ok ? list.sessions.find((candidate) => candidate.id === sessionId) : undefined;
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

async function writeSentinelAndExpectVisible(
  page: Page,
  ids: { planningSessionId: string; terminalSessionId: string },
  sentinel: string,
): Promise<void> {
  const result = await page.evaluate(async ({ terminalSessionId, command }) => {
    return window.invoker.planningTerminalWrite(terminalSessionId, command);
  }, {
    terminalSessionId: ids.terminalSessionId,
    command: `printf "${sentinel}\\n"\n`,
  });
  expect(result).toEqual({ ok: true });
  await expectPlanningTerminalSnapshotContains(page, ids, sentinel);
  await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function expectPlanningTerminalSnapshotContains(
  page: Page,
  ids: { planningSessionId: string; terminalSessionId: string },
  sentinel: string,
): Promise<void> {
  await expect.poll(async () => {
    const snapshots = await readPlanningTerminalSnapshots(page, ids);
    return {
      liveContains: snapshots.liveSnapshot.includes(sentinel),
      persistedContains: snapshots.persistedSnapshot.includes(sentinel),
    };
  }, { timeout: 10000 }).toEqual({
    liveContains: true,
    persistedContains: true,
  });
}

async function readPlanningTerminalSnapshots(
  page: Page,
  ids: { planningSessionId: string; terminalSessionId: string },
): Promise<{ liveSnapshot: string; persistedSnapshot: string }> {
  return page.evaluate(async ({ planningSessionId, terminalSessionId }) => {
    const [terminalList, planningList] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const liveSnapshot = terminalList.find((session) => session.sessionId === terminalSessionId)?.outputSnapshot ?? '';
    const persistedSnapshot = planningList.ok
      ? planningList.sessions.find((session) => session.id === planningSessionId)?.terminalOutputSnapshot ?? ''
      : '';
    return { liveSnapshot, persistedSnapshot };
  }, ids);
}

async function visibleTmuxText(page: Page): Promise<string> {
  const rawText = await page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    if (!rows) return element.textContent ?? '';
    return Array.from(rows.children)
      .map((row) => row.textContent ?? '')
      .join('\n');
  });
  return rawText
    .replace(/\u00a0/g, ' ')
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.trimEnd())
    .filter((line) => line.trim())
    .join('\n')
    .trim();
}

async function expectBuggyBlankPaneEvidence(
  page: Page,
  testInfo: TestInfo,
  evidenceName: string,
  ids: { planningSessionId: string; terminalSessionId: string },
  sentinel: string,
): Promise<void> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', ids.terminalSessionId);
  await expectPlanningTerminalSnapshotContains(page, ids, sentinel);

  const visibleText = await visibleTmuxText(page);
  const screenshotPath = testInfo.outputPath(`${evidenceName}.png`);
  const evidencePath = testInfo.outputPath(`${evidenceName}.json`);
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const snapshots = await readPlanningTerminalSnapshots(page, ids);
  writeFileSync(evidencePath, JSON.stringify({
    evidenceName,
    planningSessionId: ids.planningSessionId,
    terminalSessionId: ids.terminalSessionId,
    sentinel,
    visibleText,
    liveSnapshotContainsSentinel: snapshots.liveSnapshot.includes(sentinel),
    persistedSnapshotContainsSentinel: snapshots.persistedSnapshot.includes(sentinel),
    liveSnapshotTail: snapshots.liveSnapshot.slice(-1000),
    persistedSnapshotTail: snapshots.persistedSnapshot.slice(-1000),
  }, null, 2), 'utf8');
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${evidenceName}-terminal-text`, {
    body: visibleText || '<blank>',
    contentType: 'text/plain',
  });
  await testInfo.attach(`${evidenceName}-terminal-evidence`, {
    path: evidencePath,
    contentType: 'application/json',
  });
  await testInfo.attach(`${evidenceName}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });

  expect(snapshots.liveSnapshot).toContain(sentinel);
  expect(snapshots.persistedSnapshot).toContain(sentinel);
  expect(visibleText).not.toContain(sentinel);
  expect(visibleText).toBe('');
}

function setupTestPaths(testDir: string): { configPath: string; userDataDir: string; ipcSocketPath: string } {
  const configPath = path.join(testDir, 'e2e-config.json');
  const userDataDir = path.join(testDir, 'electron-user-data');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');
  return { configPath, userDataDir, ipcSocketPath };
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records the blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-blank-'));
    const paths = setupTestPaths(testDir);
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, ...paths }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await installPlanningResponse(page, planYaml);

      await openPlanningTerminal(page);
      const alphaPlanningSessionId = await submitDraftPrompt(page, SWITCH_ALPHA_PROMPT);
      const alphaTerminalSessionId = await openPlanningTmux(page, alphaPlanningSessionId);
      await writeSentinelAndExpectVisible(page, {
        planningSessionId: alphaPlanningSessionId,
        terminalSessionId: alphaTerminalSessionId,
      }, SWITCH_ALPHA_SENTINEL);

      await page.getByRole('button', { name: 'New chat' }).click();
      const betaPlanningSessionId = await submitDraftPrompt(page, SWITCH_BETA_PROMPT);
      const betaTerminalSessionId = await openPlanningTmux(page, betaPlanningSessionId);
      await writeSentinelAndExpectVisible(page, {
        planningSessionId: betaPlanningSessionId,
        terminalSessionId: betaTerminalSessionId,
      }, SWITCH_BETA_SENTINEL);

      await selectPlanningSession(page, SWITCH_ALPHA_PROMPT);
      await expectBuggyBlankPaneEvidence(page, testInfo, 'session-switch-back', {
        planningSessionId: alphaPlanningSessionId,
        terminalSessionId: alphaTerminalSessionId,
      }, SWITCH_ALPHA_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the blank pane after navigating away from an active planning tmux session and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-nav-blank-'));
    const paths = setupTestPaths(testDir);
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, ...paths }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await installPlanningResponse(page, planYaml);

      await openPlanningTerminal(page);
      const planningSessionId = await submitDraftPrompt(page, NAV_PROMPT);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);
      await writeSentinelAndExpectVisible(page, {
        planningSessionId,
        terminalSessionId,
      }, NAV_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expectBuggyBlankPaneEvidence(page, testInfo, 'navigate-away-back', {
        planningSessionId,
        terminalSessionId,
      }, NAV_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

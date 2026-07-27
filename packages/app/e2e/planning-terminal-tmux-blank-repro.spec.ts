import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { E2E_BROWSER_REGISTRY_ENV, registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const CLEANUP_CHROME_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'cleanup-orphaned-automation-chrome.mjs');

const PLANNING_TMUX_BLANK_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Reproduce planning terminal tmux blanking',
      command: 'echo tmux-blank-repro',
      dependencies: [],
    },
  ],
};

type PlanningTerminalEvidence = {
  phase: string;
  sessionId: string;
  backendStatus: string | null;
  backendOutputSnapshot: string;
  visibleText: string;
  normalizedVisibleText: string;
  screenshotPath: string;
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

function cleanupTrackedBrowserProcesses(): void {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];
  if (!registryPath) return;
  execFileSync(process.execPath, [CLEANUP_CHROME_SCRIPT, '--registry', registryPath], { stdio: 'inherit' });
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  }).catch(() => undefined);
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function configurePlanningHarness(page: Page): Promise<void> {
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });
}

async function createPlanningSession(page: Page, prompt: string): Promise<void> {
  await submitPlanningText(page, prompt);
  const transcript = page.getByTestId('invoker-terminal-transcript');
  await expect(transcript).toContainText(prompt, { timeout: 10000 });
  await expect(transcript).toContainText('I drafted the tmux blank repro plan.', { timeout: 10000 });
}

async function switchActivePlanningSessionToTmux(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId ?? '';
}

async function writeSentinel(page: Page, sessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, value }) => {
    return window.invoker.planningTerminalWrite(targetSessionId, `printf '%s\\n' '${value}'\n`);
  }, { targetSessionId: sessionId, value: sentinel });
  expect(result).toMatchObject({ ok: true });
  await expect.poll(async () => readVisibleTerminalText(page), { timeout: 10000 }).toContain(sentinel);
  await expect.poll(async () => readBackendOutputSnapshot(page, sessionId), { timeout: 10000 }).toContain(sentinel);
}

function normalizeTerminalText(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => (
    element.querySelector('.xterm-rows')?.textContent ?? ''
  ));
}

async function readBackendOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
}

async function captureTerminalEvidence(
  page: Page,
  testInfo: TestInfo,
  phase: string,
  sessionId: string,
): Promise<PlanningTerminalEvidence> {
  const visibleText = await readVisibleTerminalText(page);
  const backendSession = await page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId) ?? null;
  }, sessionId);
  const screenshotPath = testInfo.outputPath(`${phase}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${phase}-screenshot`, { path: screenshotPath, contentType: 'image/png' });

  const evidence: PlanningTerminalEvidence = {
    phase,
    sessionId,
    backendStatus: backendSession?.status ?? null,
    backendOutputSnapshot: backendSession?.outputSnapshot ?? '',
    visibleText,
    normalizedVisibleText: normalizeTerminalText(visibleText),
    screenshotPath,
  };
  await testInfo.attach(`${phase}-terminal-evidence`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  return evidence;
}

function expectBuggyBlankScreen(evidence: PlanningTerminalEvidence, sentinel: string): void {
  expect(evidence.backendStatus).toBe('running');
  expect(evidence.backendOutputSnapshot).toContain(sentinel);
  expect(evidence.visibleText).not.toContain(sentinel);
  expect(evidence.normalizedVisibleText).toBe('');
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank tmux pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
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
      await configurePlanningHarness(page);
      await openPlanningTerminal(page);

      await createPlanningSession(page, 'Draft tmux blank repro alpha');
      const alphaSessionId = await switchActivePlanningSessionToTmux(page);
      const alphaSentinel = '__INVOKER_PLANNING_TMUX_ALPHA_SENTINEL__';
      await writeSentinel(page, alphaSessionId, alphaSentinel);

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await createPlanningSession(page, 'Draft tmux blank repro beta');
      const betaSessionId = await switchActivePlanningSessionToTmux(page);
      const betaSentinel = '__INVOKER_PLANNING_TMUX_BETA_SENTINEL__';
      await writeSentinel(page, betaSessionId, betaSentinel);

      const sessionButtons = page.getByTestId('planning-session-list').getByRole('button');
      await sessionButtons.nth(1).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaSessionId, { timeout: 10000 });
      const alphaEvidence = await captureTerminalEvidence(page, testInfo, 'after-switch-back-to-alpha', alphaSessionId);
      expectBuggyBlankScreen(alphaEvidence, alphaSentinel);

      await sessionButtons.nth(0).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', betaSessionId, { timeout: 10000 });
      const betaEvidence = await captureTerminalEvidence(page, testInfo, 'after-switch-back-to-beta', betaSessionId);
      expectBuggyBlankScreen(betaEvidence, betaSentinel);
    } finally {
      if (page) await closePlanningTerminalSessions(page);
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTrackedBrowserProcesses();
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank tmux pane after navigating away and back while tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
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
      await configurePlanningHarness(page);
      await openPlanningTerminal(page);

      await createPlanningSession(page, 'Draft tmux blank repro navigation');
      const terminalSessionId = await switchActivePlanningSessionToTmux(page);
      const sentinel = '__INVOKER_PLANNING_TMUX_NAV_SENTINEL__';
      await writeSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => {
        const sessions = await page!.evaluate(async () => window.invoker.planningTerminalList());
        return sessions.find((session) => session.sessionId === terminalSessionId)?.status ?? null;
      }).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      const evidence = await captureTerminalEvidence(page, testInfo, 'after-navigation-back-to-planning-tmux', terminalSessionId);
      expectBuggyBlankScreen(evidence, sentinel);
    } finally {
      if (page) await closePlanningTerminalSessions(page);
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTrackedBrowserProcesses();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

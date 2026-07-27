import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const TMUX_AVAILABLE = spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status === 0;

const PLANNING_TMUX_BLANK_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'repro-readme',
      description: 'Update README',
      command: 'echo readme',
      dependencies: [],
    },
  ],
};

interface Evidence {
  name: string;
  terminalSessionId: string;
  planningSessionId: string | null;
  expectedSentinel: string;
  visibleText: string;
  visibleTextTrimmed: string;
  visibleContainsSentinel: boolean;
  persistedSnapshotTail: string;
  persistedSnapshotContainsSentinel: boolean;
  screenshotPath: string;
  evidencePath: string;
}

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

async function bootstrapDraftReadyPlanningSession(page: Page, planYaml: string): Promise<string> {
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
    return list.sessions[0]?.id ?? null;
  });
  if (!sessionId) throw new Error('Planning chat session was not created');
  return sessionId;
}

async function switchCurrentPlanningSessionToTmux(page: Page): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane has no terminal session id');
  return terminalSessionId;
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, command }) => {
    return window.invoker.planningTerminalWrite(sessionId, command);
  }, {
    sessionId: terminalSessionId,
    command: data,
  });
  expect(result.ok, result.reason ?? 'planning terminal write failed').toBe(true);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

async function attachTmuxWithSentinelPanes(
  page: Page,
  terminalSessionId: string,
  options: { socketPath: string; alphaSession: string; betaSession: string; alphaSentinel: string; betaSentinel: string },
): Promise<void> {
  const command = [
    `tmux -S ${shellQuote(options.socketPath)} kill-server >/dev/null 2>&1 || true`,
    `tmux -S ${shellQuote(options.socketPath)} new-session -d -s ${shellQuote(options.alphaSession)} ${shellQuote(`printf "\\n${options.alphaSentinel}\\n"; exec bash`)}`,
    `tmux -S ${shellQuote(options.socketPath)} new-session -d -s ${shellQuote(options.betaSession)} ${shellQuote(`printf "\\n${options.betaSentinel}\\n"; exec bash`)}`,
    `tmux -S ${shellQuote(options.socketPath)} attach-session -t ${shellQuote(options.alphaSession)}`,
  ].join(' && ');
  await writePlanningTerminal(page, terminalSessionId, 'stty -echo\r');
  await page.waitForTimeout(250);
  await writePlanningTerminal(page, terminalSessionId, `${command}\r`);
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toContainText(options.alphaSentinel, { timeout: 10000 });
  await expect.poll(() => persistedTerminalSnapshot(page, terminalSessionId), {
    message: `persisted snapshot should contain ${options.alphaSentinel}`,
    timeout: 10000,
  }).toContain(options.alphaSentinel);
}

async function switchTmuxClient(
  page: Page,
  terminalSessionId: string,
  targetSession: string,
  expectedSentinelInRawOutput: string,
): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `\x02:switch-client -t ${targetSession}\r`);
  await expect.poll(() => persistedTerminalSnapshot(page, terminalSessionId), {
    message: `persisted snapshot should contain ${expectedSentinelInRawOutput} after switching tmux clients`,
    timeout: 10000,
  }).toContain(expectedSentinelInRawOutput);
}

async function persistedTerminalSnapshot(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return session?.terminalOutputSnapshot ?? '';
  }, terminalSessionId);
}

async function currentPlanningSessionIdForTerminal(page: Page, terminalSessionId: string): Promise<string | null> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return session?.id ?? null;
  }, terminalSessionId);
}

async function assertPlanningTerminalRunning(page: Page, terminalSessionId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningTerminalList();
    return list.find((session) => session.sessionId === sessionId)?.status ?? null;
  }, terminalSessionId), {
    message: `planning terminal ${terminalSessionId} should stay running`,
    timeout: 10000,
  }).toBe('running');
}

async function terminalVisibleText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    const value = rows?.textContent ?? element.textContent ?? '';
    return value.replace(/\u00a0/g, ' ');
  });
}

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  terminalSessionId: string,
  expectedSentinel: string,
): Promise<Evidence> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane).toHaveAttribute('data-session-id', terminalSessionId);
  await page.waitForTimeout(500);

  const visibleText = await terminalVisibleText(page);
  const persistedSnapshot = await persistedTerminalSnapshot(page, terminalSessionId);
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  const evidencePath = testInfo.outputPath(`${name}.json`);
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await pane.screenshot({ path: screenshotPath });

  const evidence: Evidence = {
    name,
    terminalSessionId,
    planningSessionId: await currentPlanningSessionIdForTerminal(page, terminalSessionId),
    expectedSentinel,
    visibleText,
    visibleTextTrimmed: visibleText.trim(),
    visibleContainsSentinel: visibleText.includes(expectedSentinel),
    persistedSnapshotTail: persistedSnapshot.slice(-2000),
    persistedSnapshotContainsSentinel: persistedSnapshot.includes(expectedSentinel),
    screenshotPath,
    evidencePath,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify({
    name,
    terminalSessionId,
    planningSessionId: evidence.planningSessionId,
    visibleTextTrimmedLength: evidence.visibleTextTrimmed.length,
    visibleContainsSentinel: evidence.visibleContainsSentinel,
    persistedSnapshotContainsSentinel: evidence.persistedSnapshotContainsSentinel,
    screenshotPath,
    evidencePath,
  })}`);
  return evidence;
}

function expectCurrentBlankBug(evidence: Evidence): void {
  const evidenceMessage = JSON.stringify(evidence);
  expect(evidence.persistedSnapshotContainsSentinel, evidenceMessage).toBe(true);
  expect(evidence.visibleContainsSentinel, evidenceMessage).toBe(false);
  expect(evidence.visibleTextTrimmed, evidenceMessage).toBe('');
}

base.describe('Planning terminal tmux blank repro', () => {
  base.skip(!TMUX_AVAILABLE, 'tmux is required for the planning terminal tmux blank repro');

  base('records the current blank pane after switching tmux sessions inside the planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapDraftReadyPlanningSession(page, planYaml);

      const terminalSessionId = await switchCurrentPlanningSessionToTmux(page);
      const alphaSession = 'invoker_repro_alpha';
      const betaSession = 'invoker_repro_beta';
      const alphaSentinel = 'PLANNING_TMUX_SWITCH_ALPHA_PANE_SENTINEL';
      const betaSentinel = 'PLANNING_TMUX_SWITCH_BETA_PANE_SENTINEL';
      await attachTmuxWithSentinelPanes(page, terminalSessionId, {
        socketPath: path.join(testDir, 'planning-switch-tmux.sock'),
        alphaSession,
        betaSession,
        alphaSentinel,
        betaSentinel,
      });
      await switchTmuxClient(page, terminalSessionId, betaSession, betaSentinel);
      await switchTmuxClient(page, terminalSessionId, alphaSession, alphaSentinel);
      await assertPlanningTerminalRunning(page, terminalSessionId);
      const evidence = await captureBlankEvidence(
        page,
        testInfo,
        'planning-tmux-session-switch-back-blank',
        terminalSessionId,
        alphaSentinel,
      );
      expectCurrentBlankBug(evidence);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the current blank pane after navigating away from planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-nav-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapDraftReadyPlanningSession(page, planYaml);

      const terminalSessionId = await switchCurrentPlanningSessionToTmux(page);
      const sentinel = 'PLANNING_TMUX_NAVIGATION_SENTINEL';
      await attachTmuxWithSentinelPanes(page, terminalSessionId, {
        socketPath: path.join(testDir, 'planning-navigation-tmux.sock'),
        alphaSession: 'invoker_nav_alpha',
        betaSession: 'invoker_nav_beta',
        alphaSentinel: sentinel,
        betaSentinel: 'PLANNING_TMUX_NAVIGATION_BETA_SENTINEL',
      });

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await assertPlanningTerminalRunning(page, terminalSessionId);
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });

      const evidence = await captureBlankEvidence(
        page,
        testInfo,
        'planning-tmux-navigation-back-blank',
        terminalSessionId,
        sentinel,
      );
      expectCurrentBlankBug(evidence);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const ALPHA_SESSION = 'invoker-planning-blank-alpha';
const BETA_SESSION = 'invoker-planning-blank-beta';
const ALPHA_SENTINEL = 'PLANNING_TMUX_BLANK_REPRO_ALPHA_SENTINEL';
const BETA_SENTINEL = 'PLANNING_TMUX_BLANK_REPRO_BETA_SENTINEL';

const PLANNING_TMUX_BLANK_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Reproduce planning terminal tmux blanking',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

interface TestPaths {
  dbDir: string;
  userDataDir: string;
  ipcSocketPath: string;
  configPath: string;
  homeDir: string;
  tmuxTmpDir: string;
}

interface TerminalEvidence {
  label: string;
  terminalSessionId: string;
  screenshotPath: string;
  expectedSentinel: string;
  uiText: string;
  tmuxPaneText: string;
  uiHasExpectedSentinel: boolean;
  tmuxHasExpectedSentinel: boolean;
}

function hasTmux(): boolean {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return result.status === 0;
}

function tmuxEnv(paths: TestPaths): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: paths.homeDir,
    TMUX_TMPDIR: paths.tmuxTmpDir,
  };
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
      INVOKER_EMBEDDED_TERMINAL_BACKEND: 'pty',
      INVOKER_REPO_CONFIG_PATH: paths.configPath,
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '10000',
      HOME: paths.homeDir,
      TMUX_TMPDIR: paths.tmuxTmpDir,
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

function createTestPaths(prefix: string): TestPaths {
  const testDir = mkdtempSync(path.join(tmpdir(), prefix));
  const homeDir = path.join(testDir, 'home');
  const tmuxTmpDir = path.join(testDir, 'tmux');
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(tmuxTmpDir, { recursive: true });
  chmodSync(tmuxTmpDir, 0o700);
  const configPath = path.join(testDir, 'e2e-config.json');
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');
  return {
    dbDir: testDir,
    userDataDir: path.join(testDir, 'electron-user-data'),
    ipcSocketPath: path.join(testDir, 'ipc-transport.sock'),
    configPath,
    homeDir,
    tmuxTmpDir,
  };
}

function cleanupTestPaths(paths: TestPaths): void {
  spawnSync('tmux', ['kill-server'], { env: tmuxEnv(paths), encoding: 'utf8' });
  rmSync(paths.dbDir, { recursive: true, force: true });
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function bootstrapDraftReadyPlanningSession(page: Page): Promise<string> {
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

  await openPlanningTerminal(page);
  await submitPlanningText(page, 'Draft a YAML plan to reproduce planning tmux blanking');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  if (!planningSessionId) throw new Error('Planning session was not persisted.');
  return planningSessionId;
}

async function openPlanningTmux(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id.');
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return {
      mode: session?.terminalMode,
      terminalStatus: session?.terminalStatus,
      terminalSessionId: session?.terminalSessionId,
    };
  }, planningSessionId)).toEqual({
    mode: 'tmux',
    terminalStatus: 'running',
    terminalSessionId,
  });
  return terminalSessionId;
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, payload }) => {
    return window.invoker.planningTerminalWrite?.(sessionId, payload);
  }, { sessionId: terminalSessionId, payload: data });
  if (!result?.ok) {
    throw new Error(`planningTerminalWrite failed: ${result?.reason ?? 'unknown reason'}`);
  }
}

async function sendPlanningTerminalLine(page: Page, terminalSessionId: string, command: string): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `${command}\r`);
}

function captureTmuxPane(paths: TestPaths, sessionName: string): string {
  const result = spawnSync(
    'tmux',
    ['capture-pane', '-pt', `${sessionName}:0.0`, '-S', '-100'],
    { env: tmuxEnv(paths), encoding: 'utf8' },
  );
  return result.status === 0 ? result.stdout : result.stderr;
}

function listTmuxClientSessions(paths: TestPaths): string[] {
  const result = spawnSync(
    'tmux',
    ['list-clients', '-F', '#{client_session}'],
    { env: tmuxEnv(paths), encoding: 'utf8' },
  );
  if (result.status !== 0) return [];
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function waitForTmuxPaneText(paths: TestPaths, sessionName: string, text: string): Promise<void> {
  await expect.poll(() => captureTmuxPane(paths, sessionName), { timeout: 10000 }).toContain(text);
}

async function waitForActiveTmuxClient(paths: TestPaths, sessionName: string): Promise<void> {
  await expect.poll(() => listTmuxClientSessions(paths), { timeout: 10000 }).toContain(sessionName);
}

async function readTerminalScreenText(page: Page): Promise<string> {
  const raw = await page.getByTestId('invoker-terminal-tmux-pane').evaluate((node) => {
    const rows = Array.from(node.querySelectorAll('.xterm-rows > div'));
    const text = rows.length > 0
      ? rows.map((row) => row.textContent ?? '').join('\n')
      : node.textContent ?? '';
    return text;
  });
  return raw.replace(/\u00a0/g, ' ').replace(/\r/g, '');
}

async function waitForTerminalScreenText(page: Page, text: string): Promise<void> {
  await expect.poll(() => readTerminalScreenText(page), { timeout: 10000 }).toContain(text);
}

async function startTmuxSentinelSessions(page: Page, paths: TestPaths, terminalSessionId: string): Promise<void> {
  await sendPlanningTerminalLine(page, terminalSessionId, `tmux kill-session -t ${ALPHA_SESSION} 2>/dev/null || true`);
  await sendPlanningTerminalLine(page, terminalSessionId, `tmux kill-session -t ${BETA_SESSION} 2>/dev/null || true`);
  await sendPlanningTerminalLine(page, terminalSessionId, `tmux new-session -d -s ${BETA_SESSION} 'printf "${BETA_SENTINEL}\\n"; exec bash --noprofile --norc'`);
  await waitForTmuxPaneText(paths, BETA_SESSION, BETA_SENTINEL);
  await sendPlanningTerminalLine(page, terminalSessionId, `tmux new-session -A -s ${ALPHA_SESSION}`);
  await waitForActiveTmuxClient(paths, ALPHA_SESSION);
  await sendPlanningTerminalLine(page, terminalSessionId, `printf "${ALPHA_SENTINEL}\\n"`);
  await waitForTmuxPaneText(paths, ALPHA_SESSION, ALPHA_SENTINEL);
  await waitForTerminalScreenText(page, ALPHA_SENTINEL);
}

async function captureTerminalEvidence(
  page: Page,
  paths: TestPaths,
  terminalSessionId: string,
  label: string,
  expectedSentinel: string,
  tmuxSessionName: string,
): Promise<TerminalEvidence> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-repro-${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const uiText = await readTerminalScreenText(page);
  const tmuxPaneText = captureTmuxPane(paths, tmuxSessionName);
  const evidence = {
    label,
    terminalSessionId,
    screenshotPath,
    expectedSentinel,
    uiText,
    tmuxPaneText,
    uiHasExpectedSentinel: uiText.includes(expectedSentinel),
    tmuxHasExpectedSentinel: tmuxPaneText.includes(expectedSentinel),
  };
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify(evidence)}`);
  return evidence;
}

function expectCurrentlyBuggyBlankEvidence(evidence: TerminalEvidence): void {
  const message = JSON.stringify(evidence);
  expect(evidence.tmuxHasExpectedSentinel, message).toBe(true);
  expect(evidence.uiHasExpectedSentinel, message).toBe(false);
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(!hasTmux(), 'tmux binary is required for this planning terminal repro.');

  base('records the current blank after switching tmux sessions and back', async () => {
    const paths = createTestPaths('invoker-e2e-planning-tmux-blank-switch-');
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp(paths);
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapDraftReadyPlanningSession(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);
      await startTmuxSentinelSessions(page, paths, terminalSessionId);

      await sendPlanningTerminalLine(page, terminalSessionId, `tmux switch-client -t ${BETA_SESSION}`);
      await waitForActiveTmuxClient(paths, BETA_SESSION);
      const betaEvidence = await captureTerminalEvidence(
        page,
        paths,
        terminalSessionId,
        'session-switch-beta',
        BETA_SENTINEL,
        BETA_SESSION,
      );
      expectCurrentlyBuggyBlankEvidence(betaEvidence);

      await sendPlanningTerminalLine(page, terminalSessionId, `tmux switch-client -t ${ALPHA_SESSION}`);
      await waitForActiveTmuxClient(paths, ALPHA_SESSION);
      const alphaEvidence = await captureTerminalEvidence(
        page,
        paths,
        terminalSessionId,
        'session-switch-back-alpha',
        ALPHA_SENTINEL,
        ALPHA_SESSION,
      );
      expectCurrentlyBuggyBlankEvidence(alphaEvidence);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTestPaths(paths);
    }
  });

  base('records the current blank after navigating away and back with tmux active', async () => {
    const paths = createTestPaths('invoker-e2e-planning-tmux-blank-navigation-');
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp(paths);
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapDraftReadyPlanningSession(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);
      await startTmuxSentinelSessions(page, paths, terminalSessionId);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await expect.poll(() => listTmuxClientSessions(paths), { timeout: 10000 }).toContain(ALPHA_SESSION);
      await expect(captureTmuxPane(paths, ALPHA_SESSION)).toContain(ALPHA_SENTINEL);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      const evidence = await captureTerminalEvidence(
        page,
        paths,
        terminalSessionId,
        'navigation-back-alpha',
        ALPHA_SENTINEL,
        ALPHA_SESSION,
      );
      expectCurrentlyBuggyBlankEvidence(evidence);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTestPaths(paths);
    }
  });
});

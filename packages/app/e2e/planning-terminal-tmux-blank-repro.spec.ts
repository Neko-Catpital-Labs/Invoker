import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_TMUX_REPRO_PLAN = {
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

const SWITCH_SESSION_A_SENTINEL = 'PLANNING_TMUX_SWITCH_SESSION_A_SENTINEL';
const SWITCH_SESSION_B_SENTINEL = 'PLANNING_TMUX_SWITCH_SESSION_B_SENTINEL';
const NAVIGATION_SENTINEL = 'PLANNING_TMUX_NAVIGATION_SENTINEL';

function resolveTmuxVersion(): string | null {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

const TMUX_VERSION = resolveTmuxVersion();

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

async function launchApp(paths: {
  dbDir: string;
  userDataDir: string;
  ipcSocketPath: string;
  configPath: string;
  homeDir: string;
}): Promise<{ app: ElectronApplication; page: Page }> {
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function tmuxSocketName(testInfoTitle: string): string {
  const suffix = testInfoTitle.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32);
  return `invoker-repro-${process.pid}-${suffix || 'tmux'}`;
}

function killTmuxServer(socketName: string): void {
  spawnSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
}

async function bootstrapPlanningDraft(page: Page): Promise<string> {
  const planYaml = yamlStringify(PLANNING_TMUX_REPRO_PLAN);
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
  await submitPlanningText(page, 'Draft a YAML plan before running the tmux blank repro');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });

  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  expect(planningSessionId).toBeTruthy();
  return planningSessionId!;
}

async function openPlanningTmux(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
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
  return terminalSessionId!;
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, input }) => (
    window.invoker.planningTerminalWrite(sessionId, input)
  ), { sessionId: terminalSessionId, input: data });
  expect(result).toMatchObject({ ok: true });
}

async function terminalRows(page: Page): Promise<string[]> {
  return page.getByTestId('invoker-terminal-tmux-pane').locator('.xterm-rows').evaluate((rowsHost) => (
    Array.from(rowsHost.querySelectorAll('div')).map((row) => row.textContent?.replace(/\u00a0/g, ' ') ?? '')
  ));
}

function terminalTextFromRows(rows: string[]): string {
  return rows.join('\n');
}

function tmuxBodyText(rows: string[], ignoredChromeNeedles: readonly string[]): string {
  return rows
    .map((row) => row.replace(/\u00a0/g, ' ').trim())
    .filter((row) => row && !ignoredChromeNeedles.some((needle) => row.includes(needle)))
    .join('\n');
}

async function waitForTerminalText(page: Page, expectedText: string): Promise<string> {
  await expect.poll(async () => terminalTextFromRows(await terminalRows(page)), { timeout: 10000 }).toContain(expectedText);
  return terminalTextFromRows(await terminalRows(page));
}

async function captureTerminalEvidence(
  page: Page,
  label: string,
  details: Record<string, unknown>,
  ignoredChromeNeedles: readonly string[],
): Promise<{ rows: string[]; text: string; bodyText: string; screenshotPath: string; jsonPath: string }> {
  const rows = await terminalRows(page);
  const text = terminalTextFromRows(rows);
  const bodyText = tmuxBodyText(rows, ignoredChromeNeedles);
  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-repro-${label}.png`);
  const jsonPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-repro-${label}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  writeFileSync(
    jsonPath,
    JSON.stringify({
      label,
      recordedAt: new Date().toISOString(),
      tmuxVersion: TMUX_VERSION,
      details,
      blankBodyObserved: bodyText === '',
      text,
      rows,
      screenshotPath,
    }, null, 2),
    'utf8',
  );
  return { rows, text, bodyText, screenshotPath, jsonPath };
}

function tmuxSessionCommand(sentinel: string): string {
  return `printf "\\033[2J\\033[H${sentinel}\\n"; while :; do sleep 600; done`;
}

async function attachTmuxSessions(page: Page, terminalSessionId: string, socketName: string, sessionA: string, sessionB: string): Promise<void> {
  const setupCommand = [
    `tmux -L ${shellQuote(socketName)} new-session -d -s ${shellQuote(sessionA)} ${shellQuote(tmuxSessionCommand(SWITCH_SESSION_A_SENTINEL))}`,
    `tmux -L ${shellQuote(socketName)} new-session -d -s ${shellQuote(sessionB)} ${shellQuote(tmuxSessionCommand(SWITCH_SESSION_B_SENTINEL))}`,
    `tmux -L ${shellQuote(socketName)} attach-session -t ${shellQuote(sessionA)}`,
  ].join(' && ');
  await writePlanningTerminal(page, terminalSessionId, `${setupCommand}\r`);
  await waitForTerminalText(page, SWITCH_SESSION_A_SENTINEL);
}

async function attachNavigationTmuxSession(page: Page, terminalSessionId: string, socketName: string, sessionName: string): Promise<void> {
  const setupCommand = [
    `tmux -L ${shellQuote(socketName)} new-session -d -s ${shellQuote(sessionName)} ${shellQuote(tmuxSessionCommand(NAVIGATION_SENTINEL))}`,
    `tmux -L ${shellQuote(socketName)} attach-session -t ${shellQuote(sessionName)}`,
  ].join(' && ');
  await writePlanningTerminal(page, terminalSessionId, `${setupCommand}\r`);
  await waitForTerminalText(page, NAVIGATION_SENTINEL);
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(!TMUX_VERSION, 'tmux is required for the planning terminal blank repro');

  base('records blank screen after switching tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const homeDir = path.join(testDir, 'home');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    const socketName = tmuxSocketName(testInfo.title);
    const sessionA = 'invokerSwitchA';
    const sessionB = 'invokerSwitchB';
    const ignoredChromeNeedles = [socketName, sessionA, sessionB];
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      killTmuxServer(socketName);
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath, homeDir }));
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);

      await attachTmuxSessions(page, terminalSessionId, socketName, sessionA, sessionB);
      await writePlanningTerminal(page, terminalSessionId, `\u0002:switch-client -t ${sessionB}\r`);
      await waitForTerminalText(page, SWITCH_SESSION_B_SENTINEL);
      const afterSwitchToB = await captureTerminalEvidence(
        page,
        'switch-to-b-visible',
        { path: 'tmux switch-client to second session', terminalSessionId, socketName, sessionA, sessionB },
        ignoredChromeNeedles,
      );
      expect(afterSwitchToB.text).toContain(SWITCH_SESSION_B_SENTINEL);

      await writePlanningTerminal(page, terminalSessionId, `\u0002:switch-client -t ${sessionA}\r`);
      await delay(1500);
      const afterSwitchBack = await captureTerminalEvidence(
        page,
        'switch-back-blank',
        { path: 'tmux switch-client back to first session', terminalSessionId, socketName, sessionA, sessionB },
        ignoredChromeNeedles,
      );

      expect(afterSwitchBack.text).not.toContain(SWITCH_SESSION_A_SENTINEL);
      expect(afterSwitchBack.text).not.toContain(SWITCH_SESSION_B_SENTINEL);
      expect(afterSwitchBack.bodyText).toBe('');
    } finally {
      killTmuxServer(socketName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank screen after navigating away and back while tmux stays active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-navigation-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const homeDir = path.join(testDir, 'home');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    const socketName = tmuxSocketName(testInfo.title);
    const sessionName = 'invokerNavigation';
    const ignoredChromeNeedles = [socketName, sessionName];
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      killTmuxServer(socketName);
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath, homeDir }));
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);

      await attachNavigationTmuxSession(page, terminalSessionId, socketName, sessionName);
      const beforeNavigation = await captureTerminalEvidence(
        page,
        'navigation-before-away-visible',
        { path: 'attached tmux session before leaving Planning Terminal', terminalSessionId, socketName, sessionName },
        ignoredChromeNeedles,
      );
      expect(beforeNavigation.text).toContain(NAVIGATION_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => page!.evaluate(async (sessionId) => {
        const sessions = await window.invoker.planningTerminalList();
        return sessions.find((session) => session.sessionId === sessionId)?.status ?? null;
      }, terminalSessionId)).toBe('running');

      await page.getByTestId('sidebar-home').click();
      const pane = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(pane).toBeVisible({ timeout: 10000 });
      await expect(pane).toHaveAttribute('data-session-id', terminalSessionId);
      await delay(1500);
      const afterReturn = await captureTerminalEvidence(
        page,
        'navigation-return-blank',
        { path: 'returned to Planning Terminal while tmux session stayed running', terminalSessionId, socketName, sessionName },
        ignoredChromeNeedles,
      );

      expect(afterReturn.text).not.toContain(NAVIGATION_SENTINEL);
      expect(afterReturn.bodyText).toBe('');
    } finally {
      killTmuxServer(socketName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

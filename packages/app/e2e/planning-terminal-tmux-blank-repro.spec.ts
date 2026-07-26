import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const ALPHA_SENTINEL = 'PLANNING_TMUX_BLANK_REPRO_ALPHA';
const BETA_SENTINEL = 'PLANNING_TMUX_BLANK_REPRO_BETA';
const TMUX_CONFIG_FILE = process.platform === 'win32' ? 'NUL' : '/dev/null';

const PLANNING_TMUX_BLANK_REPRO_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
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

function launchArgs(): string[] {
  return [
    ...(process.platform === 'linux'
      ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing', '--disable-gpu-sandbox', '--disable-software-rasterizer']
      : []),
    MAIN_JS,
  ];
}

function tmuxVersion(): string | null {
  try {
    return execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

function killTmuxServer(socketName: string): void {
  try {
    execFileSync('tmux', ['-f', TMUX_CONFIG_FILE, '-L', socketName, 'kill-server'], { stdio: 'ignore' });
  } catch {
    /* the isolated test tmux server may not exist yet */
  }
}

function tmuxClientSessions(socketName: string): string[] {
  try {
    return execFileSync('tmux', ['-f', TMUX_CONFIG_FILE, '-L', socketName, 'list-clients', '-F', '#{client_session}'], { encoding: 'utf8' })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function normalizeTerminalText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\s+$/g, '');
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

async function bootstrapDraftReadyPlanningSession(page: Page): Promise<string> {
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
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
  await submitPlanningText(page, 'Draft a YAML plan to reproduce planning terminal tmux blanking');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const savedSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id;
  });
  if (!savedSessionId) throw new Error('Planning session was not saved');
  return savedSessionId;
}

async function openPlanningTmux(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');
  return terminalSessionId;
}

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    ({ terminalSessionId, input }) => window.invoker.planningTerminalWrite(terminalSessionId, input),
    { terminalSessionId: sessionId, input: data },
  );
  expect(result).toMatchObject({ ok: true });
}

async function runPlanningShellCommand(page: Page, sessionId: string, command: string): Promise<void> {
  await writePlanningTerminal(page, sessionId, `${command}\r`);
}

async function visiblePlanningTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rowText = Array.from(pane.querySelectorAll('.xterm-rows > div'))
      .map((row) => row.textContent ?? '')
      .join('\n');
    return rowText || pane.textContent || '';
  });
}

async function waitForVisibleTerminalText(page: Page, sentinel: string): Promise<void> {
  await expect.poll(async () => normalizeTerminalText(await visiblePlanningTerminalText(page)), {
    timeout: 10000,
  }).toContain(sentinel);
}

async function waitForBackendSnapshot(page: Page, planningSessionId: string, sentinel: string): Promise<string> {
  await expect.poll(async () => {
    const list = await page.evaluate(async () => window.invoker.planningChatList());
    const session = list.sessions.find((candidate) => candidate.id === planningSessionId);
    return session?.terminalOutputSnapshot ?? '';
  }, { timeout: 10000 }).toContain(sentinel);

  const snapshot = await page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return session?.terminalOutputSnapshot ?? '';
  }, planningSessionId);
  return snapshot;
}

async function attachIsolatedTmuxServer(page: Page, terminalSessionId: string, socketName: string, alphaSession: string, betaSession: string): Promise<void> {
  killTmuxServer(socketName);
  const alphaCommand = `printf '%s\\n' ${shellQuote(ALPHA_SENTINEL)}; exec sh`;
  const betaCommand = `printf '%s\\n' ${shellQuote(BETA_SENTINEL)}; exec sh`;
  const setupCommand = [
    `tmux -f ${shellQuote(TMUX_CONFIG_FILE)} -L ${shellQuote(socketName)} new-session -d -s ${shellQuote(alphaSession)} ${shellQuote(alphaCommand)}`,
    `tmux -f ${shellQuote(TMUX_CONFIG_FILE)} -L ${shellQuote(socketName)} new-session -d -s ${shellQuote(betaSession)} ${shellQuote(betaCommand)}`,
    `tmux -f ${shellQuote(TMUX_CONFIG_FILE)} -L ${shellQuote(socketName)} attach -t ${shellQuote(alphaSession)}`,
  ].join(' && ');
  await runPlanningShellCommand(page, terminalSessionId, setupCommand);
  await expect.poll(() => tmuxClientSessions(socketName), { timeout: 10000 }).toContain(alphaSession);
  await waitForVisibleTerminalText(page, ALPHA_SENTINEL);
}

async function switchTmuxSession(page: Page, terminalSessionId: string, socketName: string, targetSession: string): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `\x02:switch-client -t ${targetSession}\r`);
  await expect.poll(() => tmuxClientSessions(socketName), { timeout: 10000 }).toContain(targetSession);
}

async function captureBlankReproEvidence(page: Page, testInfo: TestInfo, label: string, planningSessionId: string): Promise<{
  visibleText: string;
  snapshot: string;
  screenshotPath: string;
}> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(750);

  const visibleText = normalizeTerminalText(await visiblePlanningTerminalText(page));
  const snapshot = await waitForBackendSnapshot(page, planningSessionId, ALPHA_SENTINEL);
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  console.log(`PLANNING_TMUX_BLANK_REPRO_EVIDENCE=${JSON.stringify({
    label,
    screenshotPath,
    visibleText,
    visibleTextLength: visibleText.length,
    visibleTextHasAlphaSentinel: visibleText.includes(ALPHA_SENTINEL),
    visibleTextHasBetaSentinel: visibleText.includes(BETA_SENTINEL),
    backendSnapshotHasAlphaSentinel: snapshot.includes(ALPHA_SENTINEL),
    backendSnapshotHasBetaSentinel: snapshot.includes(BETA_SENTINEL),
  })}`);

  return { visibleText, snapshot, screenshotPath };
}

function assertBlankScreenObserved(evidence: { visibleText: string; snapshot: string; screenshotPath: string }, expectedMissingSentinels: string[]): void {
  const message = JSON.stringify({
    screenshotPath: evidence.screenshotPath,
    visibleText: evidence.visibleText,
    backendSnapshotHasAlphaSentinel: evidence.snapshot.includes(ALPHA_SENTINEL),
    backendSnapshotHasBetaSentinel: evidence.snapshot.includes(BETA_SENTINEL),
  });
  expect(evidence.snapshot, message).toContain(ALPHA_SENTINEL);
  for (const sentinel of expectedMissingSentinels) {
    expect(evidence.visibleText, message).not.toContain(sentinel);
  }
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records the current blank pane after switching tmux sessions and back', async ({}, testInfo) => {
    const version = tmuxVersion();
    base.skip(!version, 'tmux is required for this repro e2e');

    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const socketName = `invoker-e2e-planning-blank-switch-${process.pid}`;
    const alphaSession = 'invoker-e2e-alpha';
    const betaSession = 'invoker-e2e-beta';
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapDraftReadyPlanningSession(page);
      const terminalSessionId = await openPlanningTmux(page);

      await attachIsolatedTmuxServer(page, terminalSessionId, socketName, alphaSession, betaSession);
      await switchTmuxSession(page, terminalSessionId, socketName, betaSession);
      await switchTmuxSession(page, terminalSessionId, socketName, alphaSession);

      const evidence = await captureBlankReproEvidence(page, testInfo, 'planning-terminal-tmux-blank-session-switch', planningSessionId);
      expect(evidence.snapshot).toContain(BETA_SENTINEL);
      assertBlankScreenObserved(evidence, [ALPHA_SENTINEL, BETA_SENTINEL]);
    } finally {
      killTmuxServer(socketName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the current blank pane after navigating away and back while tmux stays active', async ({}, testInfo) => {
    const version = tmuxVersion();
    base.skip(!version, 'tmux is required for this repro e2e');

    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const socketName = `invoker-e2e-planning-blank-nav-${process.pid}`;
    const alphaSession = 'invoker-e2e-alpha';
    const betaSession = 'invoker-e2e-beta';
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapDraftReadyPlanningSession(page);
      const terminalSessionId = await openPlanningTmux(page);

      await attachIsolatedTmuxServer(page, terminalSessionId, socketName, alphaSession, betaSession);
      await waitForBackendSnapshot(page, planningSessionId, ALPHA_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(() => tmuxClientSessions(socketName), { timeout: 10000 }).toContain(alphaSession);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);

      const evidence = await captureBlankReproEvidence(page, testInfo, 'planning-terminal-tmux-blank-navigation', planningSessionId);
      assertBlankScreenObserved(evidence, [ALPHA_SENTINEL]);
    } finally {
      killTmuxServer(socketName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

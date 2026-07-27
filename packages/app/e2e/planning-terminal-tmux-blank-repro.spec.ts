import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const ALPHA_SENTINEL = 'E2E_TMUX_ALPHA_SENTINEL';
const BETA_SENTINEL = 'E2E_TMUX_BETA_SENTINEL';

const PLANNING_TMUX_REPRO_PLAN = {
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

type LaunchPaths = {
  dbDir: string;
  userDataDir: string;
  ipcSocketPath: string;
  configPath: string;
};

type TmuxHarness = {
  serverName: string;
  alphaSession: string;
  betaSession: string;
};

function envWithoutTmux(): NodeJS.ProcessEnv {
  const { TMUX: _tmux, ...env } = process.env;
  return env;
}

function hasTmux(): boolean {
  return spawnSync('tmux', ['-V'], { env: envWithoutTmux(), stdio: 'ignore' }).status === 0;
}

function tmuxCommand(serverName: string, args: string[]): ReturnType<typeof spawnSync> {
  return spawnSync('tmux', ['-L', serverName, ...args], {
    env: envWithoutTmux(),
    encoding: 'utf8',
  });
}

function killTmuxServer(serverName: string): void {
  spawnSync('tmux', ['-L', serverName, 'kill-server'], {
    env: envWithoutTmux(),
    stdio: 'ignore',
  });
}

function makeTmuxHarness(testInfo: TestInfo, suffix: string): TmuxHarness {
  return {
    serverName: `invoker_e2e_${process.pid}_${testInfo.workerIndex}_${suffix}`,
    alphaSession: 'planning_blank_alpha',
    betaSession: 'planning_blank_beta',
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

async function launchApp(paths: LaunchPaths): Promise<{ app: ElectronApplication; page: Page }> {
  registerTrackedBrowserUserDataDir(paths.userDataDir);
  const app = await electron.launch({
    args: [
      ...launchArgs().slice(0, -1),
      `--user-data-dir=${paths.userDataDir}`,
      MAIN_JS,
    ],
    env: {
      ...envWithoutTmux(),
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
  await submitPlanningText(page, 'Draft a YAML plan to reproduce planning terminal tmux blanking');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });

  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  if (!planningSessionId) throw new Error('Planning session was not created.');
  return planningSessionId;
}

async function openTmuxMode(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id.');
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
  return terminalSessionId;
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    async ({ sessionId, input }) => window.invoker.planningTerminalWrite(sessionId, input),
    { sessionId: terminalSessionId, input: data },
  );
  expect(result).toEqual({ ok: true });
}

async function terminalVisibleText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((node) => {
    const rows = node.querySelector('.xterm-rows');
    return (rows?.textContent ?? node.textContent ?? '').replace(/\u00a0/g, ' ');
  });
}

function compactTerminalText(text: string): string {
  return text.replace(/[\s\u00a0\u2588]/g, '');
}

async function waitForTerminalText(page: Page, expected: string): Promise<void> {
  await expect.poll(async () => terminalVisibleText(page), { timeout: 10000 }).toContain(expected);
}

async function waitForTmuxClientSession(serverName: string, expectedSession: string): Promise<void> {
  await expect.poll(() => {
    const result = tmuxCommand(serverName, ['list-clients', '-F', '#{session_name}']);
    if (result.status !== 0) return [];
    return String(result.stdout).trim().split('\n').filter(Boolean);
  }, { timeout: 10000 }).toContain(expectedSession);
}

function captureTmuxPane(serverName: string, sessionName: string): string {
  const result = tmuxCommand(serverName, ['capture-pane', '-p', '-t', sessionName]);
  if (result.status !== 0) {
    throw new Error(`tmux capture-pane failed: ${result.stderr || result.stdout || result.status}`);
  }
  return String(result.stdout);
}

async function startSeededTmux(page: Page, terminalSessionId: string, harness: TmuxHarness): Promise<void> {
  const tmux = `tmux -f /dev/null -L ${harness.serverName}`;
  await writePlanningTerminal(page, terminalSessionId, [
    `${tmux} kill-server 2>/dev/null || true`,
    `${tmux} new-session -d -s ${harness.alphaSession} 'env PS1="alpha$ " bash --noprofile --norc'`,
    `${tmux} send-keys -t ${harness.alphaSession} 'printf "${ALPHA_SENTINEL}\\n"' C-m`,
    `${tmux} new-session -d -s ${harness.betaSession} 'env PS1="beta$ " bash --noprofile --norc'`,
    `${tmux} send-keys -t ${harness.betaSession} 'printf "${BETA_SENTINEL}\\n"' C-m`,
    `${tmux} attach-session -t ${harness.alphaSession}`,
  ].join('\n') + '\n');
  await waitForTmuxClientSession(harness.serverName, harness.alphaSession);
  expect(captureTmuxPane(harness.serverName, harness.alphaSession)).toContain(ALPHA_SENTINEL);
  expect(captureTmuxPane(harness.serverName, harness.betaSession)).toContain(BETA_SENTINEL);
  await waitForTerminalText(page, ALPHA_SENTINEL);
}

async function getPlanningTerminalStatus(page: Page, terminalSessionId: string): Promise<{ status?: string; sessionId?: string }> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    return { status: session?.status, sessionId: session?.sessionId };
  }, terminalSessionId);
}

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  harness: TmuxHarness,
  phase: string,
  tmuxSessionName: string,
  expectedSentinel: string,
): Promise<void> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalText = await terminalVisibleText(page);
  const tmuxPaneText = captureTmuxPane(harness.serverName, tmuxSessionName);
  await testInfo.attach(`${phase}-terminal-text.txt`, {
    body: [
      `phase=${phase}`,
      `expectedSentinel=${expectedSentinel}`,
      '',
      '[tmux capture-pane]',
      tmuxPaneText,
      '',
      '[xterm visible text]',
      terminalText || '<blank>',
    ].join('\n'),
    contentType: 'text/plain',
  });
  await testInfo.attach(`${phase}-terminal-pane.png`, {
    body: await pane.screenshot(),
    contentType: 'image/png',
  });

  expect(tmuxPaneText).toContain(expectedSentinel);
  // Repro assertion: the known defect leaves the mounted planning xterm blank
  // even though tmux still has the sentinel in the active pane.
  expect(terminalText).not.toContain(expectedSentinel);
  expect(compactTerminalText(terminalText), `${phase} xterm text should be blank for the current repro`).toBe('');
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(!hasTmux(), 'tmux must be installed to exercise planning terminal tmux switching.');

  base('records blank pane after switching tmux sessions inside the planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const harness = makeTmuxHarness(testInfo, 'switch');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openTmuxMode(page, planningSessionId);
      await startSeededTmux(page, terminalSessionId, harness);

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${harness.betaSession}\n`);
      await waitForTmuxClientSession(harness.serverName, harness.betaSession);
      await page.waitForTimeout(750);
      await captureBlankEvidence(
        page,
        testInfo,
        harness,
        'after-switch-to-beta',
        harness.betaSession,
        BETA_SENTINEL,
      );

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${harness.alphaSession}\n`);
      await waitForTmuxClientSession(harness.serverName, harness.alphaSession);
      await page.waitForTimeout(750);
      await captureBlankEvidence(
        page,
        testInfo,
        harness,
        'after-switch-back-to-alpha',
        harness.alphaSession,
        ALPHA_SENTINEL,
      );
      await expect.poll(() => getPlanningTerminalStatus(page, terminalSessionId)).toEqual({
        status: 'running',
        sessionId: terminalSessionId,
      });
    } finally {
      killTmuxServer(harness.serverName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank pane after navigating away and back while tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const harness = makeTmuxHarness(testInfo, 'nav');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openTmuxMode(page, planningSessionId);
      await startSeededTmux(page, terminalSessionId, harness);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(() => getPlanningTerminalStatus(page, terminalSessionId)).toEqual({
        status: 'running',
        sessionId: terminalSessionId,
      });
      await waitForTmuxClientSession(harness.serverName, harness.alphaSession);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      await page.waitForTimeout(750);
      await captureBlankEvidence(
        page,
        testInfo,
        harness,
        'after-navigate-away-and-back',
        harness.alphaSession,
        ALPHA_SENTINEL,
      );
    } finally {
      killTmuxServer(harness.serverName);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

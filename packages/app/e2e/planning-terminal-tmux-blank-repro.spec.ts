import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
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
      description: 'Reproduce planning tmux blanking',
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

async function bootstrapPlanning(page: Page): Promise<void> {
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
}

async function createDraftPlanningChat(page: Page, title: string): Promise<string> {
  await submitPlanningText(page, title);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate((expectedTitle) => {
    return window.invoker.planningChatList().then((list) => {
      const session = list.sessions.find((candidate) => candidate.title === expectedTitle);
      return session?.id ?? null;
    });
  }, title);
  if (!sessionId) throw new Error(`Planning session "${title}" was not created`);
  return sessionId;
}

async function openTmuxForActivePlanningSession(page: Page): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');
  return terminalSessionId;
}

async function openPlanningTmuxWithDraft(page: Page, title: string): Promise<{ planningSessionId: string; terminalSessionId: string }> {
  const planningSessionId = await createDraftPlanningChat(page, title);
  const terminalSessionId = await openTmuxForActivePlanningSession(page);
  return { planningSessionId, terminalSessionId };
}

async function visibleTmuxText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rows = pane.querySelector('.xterm-rows');
    return rows?.textContent ?? pane.textContent ?? '';
  });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\u200b/g, '').trim();
}

async function waitForVisibleSentinel(page: Page, sentinel: string): Promise<void> {
  await expect.poll(async () => normalizeTerminalText(await visibleTmuxText(page)), {
    message: `expected tmux pane to show ${sentinel} before the repro switch`,
    timeout: 10000,
  }).toContain(sentinel);
}

async function writeTerminalInput(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, input }) => {
    return window.invoker.planningTerminalWrite(sessionId, input);
  }, { sessionId: terminalSessionId, input: data });
  expect(result).toEqual({ ok: true });
}

async function persistedSnapshotFor(page: Page, planningSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return session?.terminalOutputSnapshot ?? '';
  }, planningSessionId);
}

async function waitForPersistedSentinel(page: Page, planningSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => persistedSnapshotFor(page, planningSessionId), {
    message: `expected persisted planning tmux snapshot to contain ${sentinel}`,
    timeout: 10000,
  }).toContain(sentinel);
}

async function expectPlanningTerminalRunning(page: Page, terminalSessionId: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.status;
  }, terminalSessionId), {
    message: `expected planning terminal ${terminalSessionId} to remain running`,
    timeout: 10000,
  }).toBe('running');
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function tmuxSafeName(testDir: string, label: string): string {
  const suffix = path.basename(testDir).replace(/[^A-Za-z0-9_]/g, '_').slice(-24);
  return `invoker_${label}_${suffix}`;
}

function cleanupTmuxServer(socketName: string): void {
  spawnSync('tmux', ['-L', socketName, 'kill-server'], { stdio: 'ignore' });
}

async function attachIsolatedTmuxSessions(
  page: Page,
  terminalSessionId: string,
  opts: {
    socketName: string;
    alphaSessionName: string;
    betaSessionName: string;
    alphaSentinel: string;
    betaSentinel: string;
  },
): Promise<void> {
  const alphaPaneCommand = `printf "${opts.alphaSentinel}\\n"; exec sh`;
  const betaPaneCommand = `printf "${opts.betaSentinel}\\n"; exec sh`;
  const command = [
    `tmux -L ${opts.socketName} kill-server >/dev/null 2>&1 || true`,
    `tmux -L ${opts.socketName} new-session -d -s ${opts.alphaSessionName} ${shellQuote(alphaPaneCommand)}`,
    `tmux -L ${opts.socketName} new-session -d -s ${opts.betaSessionName} ${shellQuote(betaPaneCommand)}`,
    `tmux -L ${opts.socketName} attach-session -t ${opts.alphaSessionName}`,
  ].join('; ');

  await writeTerminalInput(page, terminalSessionId, `${command}\r`);
  await waitForVisibleSentinel(page, opts.alphaSentinel);
}

async function switchTmuxClient(page: Page, terminalSessionId: string, targetSessionName: string): Promise<void> {
  await writeTerminalInput(page, terminalSessionId, '\x02');
  await page.waitForTimeout(100);
  await writeTerminalInput(page, terminalSessionId, `:switch-client -t ${targetSessionName}\r`);
}

async function recordBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  evidenceName: string,
  details: {
    planningSessionId: string;
    terminalSessionId: string;
    sentinel: string;
    tmuxSocketName?: string;
    tmuxSessionName?: string;
    switchedFrom?: string;
    switchedTo?: string;
  },
): Promise<{ normalizedVisibleText: string; persistedSnapshot: string }> {
  const visibleText = await visibleTmuxText(page);
  const normalizedVisibleText = normalizeTerminalText(visibleText);
  const persistedSnapshot = await persistedSnapshotFor(page, details.planningSessionId);
  const runningTerminals = await page.evaluate(async () => window.invoker.planningTerminalList());
  const screenshotPath = testInfo.outputPath(`${evidenceName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${evidenceName}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  await testInfo.attach(`${evidenceName}-terminal-evidence`, {
    body: JSON.stringify({
      evidenceName,
      ...details,
      normalizedVisibleText,
      visibleTextLength: normalizedVisibleText.length,
      persistedSnapshotContainsSentinel: persistedSnapshot.includes(details.sentinel),
      persistedSnapshotTail: persistedSnapshot.slice(-500),
      runningTerminals: runningTerminals.map((session) => ({
        sessionId: session.sessionId,
        planningSessionId: session.planningSessionId,
        status: session.status,
      })),
      screenshotPath,
    }, null, 2),
    contentType: 'application/json',
  });
  return { normalizedVisibleText, persistedSnapshot };
}

function writeConfig(testDir: string): { configPath: string; userDataDir: string; ipcSocketPath: string } {
  const configPath = path.join(testDir, 'e2e-config.json');
  const userDataDir = path.join(testDir, 'electron-user-data');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');
  return { configPath, userDataDir, ipcSocketPath };
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(spawnSync('tmux', ['-V'], { stdio: 'ignore' }).status !== 0, 'tmux is required for this repro');

  base('records blank pane after switching tmux sessions inside the planning terminal and switching back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-client-'));
    const paths = writeConfig(testDir);
    const tmuxSocketName = tmuxSafeName(testDir, 'socket');
    const alphaTmuxSessionName = tmuxSafeName(testDir, 'alpha');
    const betaTmuxSessionName = tmuxSafeName(testDir, 'beta');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, ...paths });
      app = launched.app;
      const page = launched.page;
      await bootstrapPlanning(page);

      const title = 'Switch client tmux blank repro';
      const alphaSentinel = 'PLANNING_TMUX_ALPHA_SENTINEL_178494';
      const betaSentinel = 'PLANNING_TMUX_BETA_SENTINEL_178494';

      const { planningSessionId, terminalSessionId } = await openPlanningTmuxWithDraft(page, title);
      await attachIsolatedTmuxSessions(page, terminalSessionId, {
        socketName: tmuxSocketName,
        alphaSessionName: alphaTmuxSessionName,
        betaSessionName: betaTmuxSessionName,
        alphaSentinel,
        betaSentinel,
      });
      await waitForPersistedSentinel(page, planningSessionId, alphaSentinel);

      await switchTmuxClient(page, terminalSessionId, betaTmuxSessionName);
      await waitForPersistedSentinel(page, planningSessionId, betaSentinel);

      await switchTmuxClient(page, terminalSessionId, alphaTmuxSessionName);
      await page.waitForTimeout(500);
      await expectPlanningTerminalRunning(page, terminalSessionId);

      const evidence = await recordBlankEvidence(page, testInfo, 'planning-tmux-switch-client-blank', {
        planningSessionId,
        terminalSessionId,
        sentinel: alphaSentinel,
        tmuxSocketName,
        tmuxSessionName: alphaTmuxSessionName,
        switchedFrom: betaTmuxSessionName,
        switchedTo: alphaTmuxSessionName,
      });
      expect(evidence.persistedSnapshot).toContain(alphaSentinel);
      expect(evidence.normalizedVisibleText).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTmuxServer(tmuxSocketName);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank pane after navigating away and back while planning tmux stays active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-navigation-'));
    const paths = writeConfig(testDir);
    const tmuxSocketName = tmuxSafeName(testDir, 'socket');
    const tmuxSessionName = tmuxSafeName(testDir, 'nav');
    const unusedTmuxSessionName = tmuxSafeName(testDir, 'nav_unused');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, ...paths });
      app = launched.app;
      const page = launched.page;
      await bootstrapPlanning(page);

      const title = 'Navigation tmux blank repro';
      const sentinel = 'PLANNING_TMUX_NAV_SENTINEL_178494';
      const unusedSentinel = 'PLANNING_TMUX_NAV_UNUSED_SENTINEL_178494';
      const { planningSessionId, terminalSessionId } = await openPlanningTmuxWithDraft(page, title);
      await attachIsolatedTmuxSessions(page, terminalSessionId, {
        socketName: tmuxSocketName,
        alphaSessionName: tmuxSessionName,
        betaSessionName: unusedTmuxSessionName,
        alphaSentinel: sentinel,
        betaSentinel: unusedSentinel,
      });
      await waitForPersistedSentinel(page, planningSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expectPlanningTerminalRunning(page, terminalSessionId);

      await page.getByTestId('sidebar-home').click();
      const pane = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(pane).toBeVisible({ timeout: 10000 });
      await expect(pane).toHaveAttribute('data-session-id', terminalSessionId);
      await expectPlanningTerminalRunning(page, terminalSessionId);

      const evidence = await recordBlankEvidence(page, testInfo, 'planning-tmux-navigation-blank', {
        planningSessionId,
        terminalSessionId,
        sentinel,
        tmuxSocketName,
        tmuxSessionName,
      });
      expect(evidence.persistedSnapshot).toContain(sentinel);
      expect(evidence.normalizedVisibleText).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTmuxServer(tmuxSocketName);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

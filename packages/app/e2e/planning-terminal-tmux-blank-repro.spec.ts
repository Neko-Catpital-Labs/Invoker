import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const TMUX_AVAILABLE = spawnSync('tmux', ['-V'], { encoding: 'utf8' }).status === 0;

const PLANNING_TMUX_BLANK_PLAN = {
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

const SESSION_SWITCH_A_SENTINEL = 'TMUX_BLANK_REPRO_SESSION_SWITCH_A_SENTINEL';
const SESSION_SWITCH_B_SENTINEL = 'TMUX_BLANK_REPRO_SESSION_SWITCH_B_SENTINEL';
const NAVIGATION_SENTINEL = 'TMUX_BLANK_REPRO_NAVIGATION_SENTINEL';

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

async function bootstrapPlanningDraft(page: Page): Promise<string> {
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
    return list.sessions[0]?.id;
  });
  if (!planningSessionId) throw new Error('Planning session was not created');
  return planningSessionId;
}

async function switchPlanningTerminalToTmux(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');

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

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ terminalSessionId, payload }) => (
    window.invoker.planningTerminalWrite(terminalSessionId, payload)
  ), { terminalSessionId: sessionId, payload: data });
  expect(result).toMatchObject({ ok: true });
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((node) => {
    const rows = node.querySelector('.xterm-rows');
    const target = rows instanceof HTMLElement ? rows : node;
    return (target as HTMLElement).innerText.replace(/\u00a0/g, ' ');
  });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function waitForVisibleTerminalText(page: Page, expected: string): Promise<void> {
  await expect.poll(async () => readVisibleTerminalText(page), { timeout: 10000 }).toContain(expected);
}

async function waitForTerminalSnapshot(page: Page, sessionId: string, expected: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ terminalSessionId }) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === terminalSessionId)?.outputSnapshot ?? '';
  }, { terminalSessionId: sessionId }), { timeout: 10000 }).toContain(expected);
}

type TerminalEvidence = {
  visibleText: string;
  normalizedVisibleText: string;
  outputSnapshot: string;
};

async function captureTerminalEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  sessionId: string,
): Promise<TerminalEvidence> {
  const visibleText = await readVisibleTerminalText(page);
  const outputSnapshot = await page.evaluate(async ({ terminalSessionId }) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === terminalSessionId)?.outputSnapshot ?? '';
  }, { terminalSessionId: sessionId });
  const evidence = {
    visibleText,
    normalizedVisibleText: normalizeTerminalText(visibleText),
    outputSnapshot,
  };
  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${label}-terminal-evidence`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(`${label}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return evidence;
}

function expectBuggyBlankTerminal(evidence: TerminalEvidence, expectedSnapshotSentinels: string[]): void {
  for (const sentinel of expectedSnapshotSentinels) {
    expect(evidence.outputSnapshot).toContain(sentinel);
    expect(evidence.visibleText).not.toContain(sentinel);
  }
  expect(evidence.normalizedVisibleText).toBe('');
}

function tmuxSessionName(testInfo: TestInfo, suffix: string): string {
  return `inv-e2e-${testInfo.workerIndex}-${process.pid}-${suffix}`;
}

function cleanupTmuxSessions(sessionNames: string[]): void {
  for (const sessionName of sessionNames) {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  }
}

async function attachTmuxSessionWithSentinels(
  page: Page,
  terminalSessionId: string,
  sessions: Array<{ name: string; sentinel: string }>,
  initialSessionName: string,
): Promise<void> {
  const script = [
    ...sessions.map((session) => `tmux kill-session -t ${session.name} >/dev/null 2>&1 || true`),
    ...sessions.map((session) => `tmux new-session -d -s ${session.name} "printf '%s\\n' '${session.sentinel}'; exec sh"`),
    `tmux attach-session -t ${initialSessionName}`,
  ].join('\n');
  await writePlanningTerminal(page, terminalSessionId, `${script}\n`);
}

base.describe('Planning terminal tmux blank repro', () => {
  base.skip(!TMUX_AVAILABLE, 'tmux must be installed to reproduce planning terminal tmux blanking.');

  base('records blank pane after switching tmux sessions inside the planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const sessionA = tmuxSessionName(testInfo, 'switch-a');
    const sessionB = tmuxSessionName(testInfo, 'switch-b');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await switchPlanningTerminalToTmux(page, planningSessionId);

      await attachTmuxSessionWithSentinels(
        page,
        terminalSessionId,
        [
          { name: sessionA, sentinel: SESSION_SWITCH_A_SENTINEL },
          { name: sessionB, sentinel: SESSION_SWITCH_B_SENTINEL },
        ],
        sessionA,
      );
      await waitForVisibleTerminalText(page, SESSION_SWITCH_A_SENTINEL);
      await waitForTerminalSnapshot(page, terminalSessionId, SESSION_SWITCH_A_SENTINEL);

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${sessionB}\n`);
      await waitForVisibleTerminalText(page, SESSION_SWITCH_B_SENTINEL);
      await waitForTerminalSnapshot(page, terminalSessionId, SESSION_SWITCH_B_SENTINEL);

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${sessionA}\n`);
      await expect.poll(async () => normalizeTerminalText(await readVisibleTerminalText(page)), { timeout: 10000 }).toBe('');
      const evidence = await captureTerminalEvidence(page, testInfo, 'session-switch-back', terminalSessionId);

      expectBuggyBlankTerminal(evidence, [SESSION_SWITCH_A_SENTINEL, SESSION_SWITCH_B_SENTINEL]);
    } finally {
      cleanupTmuxSessions([sessionA, sessionB]);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank pane after leaving the planning terminal view and returning with tmux active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const tmuxSession = tmuxSessionName(testInfo, 'navigation');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await switchPlanningTerminalToTmux(page, planningSessionId);

      await attachTmuxSessionWithSentinels(
        page,
        terminalSessionId,
        [{ name: tmuxSession, sentinel: NAVIGATION_SENTINEL }],
        tmuxSession,
      );
      await waitForVisibleTerminalText(page, NAVIGATION_SENTINEL);
      await waitForTerminalSnapshot(page, terminalSessionId, NAVIGATION_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(async ({ terminalSessionId: id }) => {
        const sessions = await window.invoker.planningTerminalList();
        return sessions.find((session) => session.sessionId === id)?.status;
      }, { terminalSessionId })).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      await expect.poll(async () => normalizeTerminalText(await readVisibleTerminalText(page)), { timeout: 10000 }).toBe('');
      const evidence = await captureTerminalEvidence(page, testInfo, 'navigation-back', terminalSessionId);

      expectBuggyBlankTerminal(evidence, [NAVIGATION_SENTINEL]);
    } finally {
      cleanupTmuxSessions([tmuxSession]);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

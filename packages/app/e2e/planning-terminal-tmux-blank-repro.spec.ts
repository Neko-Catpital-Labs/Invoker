import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const ALPHA_SENTINEL = 'TMUX_BLANK_REPRO_ALPHA_SENTINEL';
const BETA_SENTINEL = 'TMUX_BLANK_REPRO_BETA_SENTINEL';

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

type TmuxSessionNames = {
  alpha: string;
  beta: string;
};

type TmuxEvidence = {
  label: string;
  terminalSessionId: string;
  visibleText: string;
  visibleTextLength: number;
  liveSessionStatus: string | null;
  liveSessionOutputSnapshot: string;
  planningSessionId: string | null;
  planningSessionMode: string | null;
  planningSessionTerminalStatus: string | null;
  planningSessionOutputSnapshot: string;
  screenshotPath: string;
};

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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
  await submitPlanningText(page, 'Draft a YAML plan to reproduce the planning terminal tmux blank screen');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  expect(planningSessionId).toBeTruthy();
  return planningSessionId!;
}

async function openPlanningTmux(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
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
  return terminalSessionId!;
}

function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function tmuxSessionNames(testInfo: TestInfo): TmuxSessionNames {
  const suffix = `${process.pid}-${testInfo.workerIndex}-${testInfo.retry}`;
  return {
    alpha: `invoker_blank_alpha_${suffix}`,
    beta: `invoker_blank_beta_${suffix}`,
  };
}

function buildTmuxBootstrapCommand(names: TmuxSessionNames): string {
  const alphaScript = `printf "${ALPHA_SENTINEL}\\n"; exec bash --noprofile --norc`;
  const betaScript = `printf "${BETA_SENTINEL}\\n"; exec bash --noprofile --norc`;
  return [
    `tmux kill-session -t ${shellQuote(names.alpha)} 2>/dev/null || true`,
    `tmux kill-session -t ${shellQuote(names.beta)} 2>/dev/null || true`,
    `tmux new-session -d -s ${shellQuote(names.alpha)} ${shellQuote(alphaScript)}`,
    `tmux new-session -d -s ${shellQuote(names.beta)} ${shellQuote(betaScript)}`,
    `tmux attach-session -t ${shellQuote(names.alpha)}`,
  ].join('; ');
}

function killTmuxSessions(names: TmuxSessionNames): void {
  for (const sessionName of [names.alpha, names.beta]) {
    try {
      execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    } catch {
      /* best-effort cleanup */
    }
  }
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, chunk }) =>
    window.invoker.planningTerminalWrite(sessionId, chunk),
  { sessionId: terminalSessionId, chunk: data });
  if (!result?.ok) {
    throw new Error(`planningTerminalWrite failed: ${result?.reason ?? 'unknown reason'}`);
  }
}

async function visibleTerminalText(page: Page): Promise<string> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rowContainer = pane.querySelector('.xterm-rows');
    const rows = rowContainer
      ? Array.from(rowContainer.children).map((row) => row.textContent ?? '')
      : [];
    const accessibilityRows = Array.from(pane.querySelectorAll('.xterm-accessibility-tree div'))
      .map((row) => row.textContent ?? '');
    const rawText = rows.length > 0
      ? rows.join('\n')
      : accessibilityRows.length > 0
        ? accessibilityRows.join('\n')
        : pane.textContent ?? '';
    return rawText.replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').trimEnd();
  });
}

async function waitForVisibleTerminalText(page: Page, expectedText: string): Promise<void> {
  await expect.poll(async () => visibleTerminalText(page), { timeout: 10000 }).toContain(expectedText);
}

async function waitForBackendSnapshot(page: Page, terminalSessionId: string, expectedText: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ sessionId }) => {
    const terminalList = await window.invoker.planningTerminalList();
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId);
    return terminal?.outputSnapshot ?? '';
  }, { sessionId: terminalSessionId }), { timeout: 10000 }).toContain(expectedText);
}

async function seedTmuxSessions(
  page: Page,
  terminalSessionId: string,
  names: TmuxSessionNames,
): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `${buildTmuxBootstrapCommand(names)}\r`);
  await waitForVisibleTerminalText(page, ALPHA_SENTINEL);
  await waitForBackendSnapshot(page, terminalSessionId, ALPHA_SENTINEL);
}

async function switchTmuxClient(
  page: Page,
  terminalSessionId: string,
  targetSessionName: string,
  expectedText: string,
): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${shellQuote(targetSessionName)}\r`);
  await waitForBackendSnapshot(page, terminalSessionId, expectedText);
}

async function sendTmuxSwitchClient(
  page: Page,
  terminalSessionId: string,
  targetSessionName: string,
): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${shellQuote(targetSessionName)}\r`);
  await delay(500);
}

async function captureTmuxEvidence(
  page: Page,
  terminalSessionId: string,
  label: string,
  testInfo: TestInfo,
): Promise<TmuxEvidence> {
  const visibleText = await visibleTerminalText(page);
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const state = await page.evaluate(async ({ sessionId }) => {
    const [terminalList, planningList] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const liveSession = terminalList.find((candidate) => candidate.sessionId === sessionId);
    const planningSession = planningList.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return {
      liveSessionStatus: liveSession?.status ?? null,
      liveSessionOutputSnapshot: liveSession?.outputSnapshot ?? '',
      planningSessionId: planningSession?.id ?? null,
      planningSessionMode: planningSession?.terminalMode ?? null,
      planningSessionTerminalStatus: planningSession?.terminalStatus ?? null,
      planningSessionOutputSnapshot: planningSession?.terminalOutputSnapshot ?? '',
    };
  }, { sessionId: terminalSessionId });
  const evidence: TmuxEvidence = {
    label,
    terminalSessionId,
    visibleText,
    visibleTextLength: visibleText.trim().length,
    screenshotPath,
    ...state,
  };
  await testInfo.attach(`${label}-screenshot`, { path: screenshotPath, contentType: 'image/png' });
  await testInfo.attach(`${label}-evidence`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify(evidence)}`);
  return evidence;
}

function expectBuggyBlankTerminalEvidence(evidence: TmuxEvidence, expectedSnapshotText: string): void {
  const evidenceMessage = JSON.stringify(evidence);
  expect(evidence.liveSessionStatus, evidenceMessage).toBe('running');
  expect(evidence.planningSessionMode, evidenceMessage).toBe('tmux');
  expect(evidence.planningSessionTerminalStatus, evidenceMessage).toBe('running');
  expect(evidence.liveSessionOutputSnapshot, evidenceMessage).toContain(expectedSnapshotText);
  expect(evidence.planningSessionOutputSnapshot, evidenceMessage).toContain(expectedSnapshotText);
  expect(evidence.visibleText.trim(), evidenceMessage).toBe('');
}

base.describe('Planning terminal tmux blank repro', () => {
  base.skip(!hasTmux(), 'tmux is required for the planning terminal blank-screen repro.');
  base.setTimeout(60_000);

  base('records the blank screen after switching tmux sessions and switching back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const homeDir = path.join(testDir, 'home');
    const tmuxNames = tmuxSessionNames(testInfo);
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath, homeDir });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);

      await seedTmuxSessions(page, terminalSessionId, tmuxNames);
      await switchTmuxClient(page, terminalSessionId, tmuxNames.beta, BETA_SENTINEL);
      await sendTmuxSwitchClient(page, terminalSessionId, tmuxNames.alpha);

      const evidence = await captureTmuxEvidence(
        page,
        terminalSessionId,
        'planning-terminal-tmux-session-switch-blank-repro',
        testInfo,
      );
      expect(evidence.liveSessionOutputSnapshot, JSON.stringify(evidence)).toContain(BETA_SENTINEL);
      expectBuggyBlankTerminalEvidence(evidence, ALPHA_SENTINEL);
    } finally {
      killTmuxSessions(tmuxNames);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the blank screen after leaving the planning terminal and returning', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-navigation-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const homeDir = path.join(testDir, 'home');
    const tmuxNames = tmuxSessionNames(testInfo);
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath, homeDir });
      app = launched.app;
      const page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);

      await seedTmuxSessions(page, terminalSessionId, tmuxNames);
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await expect.poll(async () => page.evaluate(async ({ sessionId }) => {
        const terminalList = await window.invoker.planningTerminalList();
        return terminalList.find((candidate) => candidate.sessionId === sessionId)?.status ?? null;
      }, { sessionId: terminalSessionId })).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      const evidence = await captureTmuxEvidence(
        page,
        terminalSessionId,
        'planning-terminal-tmux-navigation-blank-repro',
        testInfo,
      );
      expectBuggyBlankTerminalEvidence(evidence, ALPHA_SENTINEL);
    } finally {
      killTmuxSessions(tmuxNames);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

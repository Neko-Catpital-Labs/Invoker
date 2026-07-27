import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
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
      id: 'record-tmux-blank-repro',
      description: 'Record planning terminal tmux blank repro',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

const FIRST_SENTINEL = 'TMUX_BLANK_REPRO_FIRST_SENTINEL';
const SECOND_SENTINEL = 'TMUX_BLANK_REPRO_SECOND_SENTINEL';
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
      INVOKER_EMBEDDED_TERMINAL_BACKEND: 'bash',
      INVOKER_REPO_CONFIG_PATH: paths.configPath,
      INVOKER_STANDALONE_OWNER_IDLE_TIMEOUT_MS:
        process.env.INVOKER_E2E_STANDALONE_OWNER_IDLE_TIMEOUT_MS ?? '10000',
      HOME: paths.dbDir,
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

async function configurePlanningResponse(page: Page, planYaml: string): Promise<void> {
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });
}

async function createDraftPlanningSession(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (expectedPrompt) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => (
      session.messages.some((message) => message.role === 'user' && message.text === expectedPrompt)
    ))?.id ?? null;
  }, prompt);
  if (!sessionId) throw new Error(`Planning session for prompt "${prompt}" was not created`);
  return sessionId;
}

async function createSecondDraftPlanningSession(page: Page, prompt: string): Promise<string> {
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  return createDraftPlanningSession(page, prompt);
}

async function openTmuxForActivePlanningSession(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  const tmuxPane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(tmuxPane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await tmuxPane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');
  await expect.poll(async () => page.evaluate(async ({ sessionId, planningId }) => {
    const [terminalList, chatList] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId);
    const planning = chatList.sessions.find((candidate) => candidate.id === planningId);
    return {
      terminalPlanningSessionId: terminal?.planningSessionId,
      planningTerminalSessionId: planning?.terminalSessionId,
      planningTerminalMode: planning?.terminalMode,
      planningTerminalStatus: planning?.terminalStatus,
    };
  }, { sessionId: terminalSessionId, planningId: planningSessionId })).toEqual({
    terminalPlanningSessionId: planningSessionId,
    planningTerminalSessionId: terminalSessionId,
    planningTerminalMode: 'tmux',
    planningTerminalStatus: 'running',
  });
  return terminalSessionId;
}

async function visibleTmuxText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    const rawText = ((rows as HTMLElement | null)?.innerText ?? (element as HTMLElement).innerText ?? element.textContent ?? '');
    return rawText
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  });
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, text }) => {
    return window.invoker.planningTerminalWrite(sessionId, `printf '%s\\n' '${text}'\n`);
  }, { sessionId: terminalSessionId, text: sentinel });
  expect(result).toMatchObject({ ok: true });
  await expect.poll(async () => page.evaluate(async ({ sessionId, text }) => {
    const [terminalList, chatList] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId);
    const planning = chatList.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return {
      terminalSnapshotHasSentinel: Boolean(terminal?.outputSnapshot?.includes(text)),
      planningSnapshotHasSentinel: Boolean(planning?.terminalOutputSnapshot?.includes(text)),
    };
  }, { sessionId: terminalSessionId, text: sentinel }), { timeout: 10000 }).toEqual({
    terminalSnapshotHasSentinel: true,
    planningSnapshotHasSentinel: true,
  });
  await expect.poll(() => visibleTmuxText(page), { timeout: 10000 }).toContain(sentinel);
}

async function selectPlanningSession(page: Page, planningSessionId: string, terminalSessionId: string): Promise<void> {
  const index = await page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.findIndex((session) => session.id === sessionId);
  }, planningSessionId);
  if (index < 0) throw new Error(`Planning session "${planningSessionId}" was not listed`);
  await page.getByTestId('planning-session-list').getByRole('button').nth(index).click();
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
}

function tail(value: string | undefined, maxLength = 2000): string {
  return (value ?? '').slice(-maxLength);
}

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  scenario: 'session-switch' | 'navigate-away-back',
  details: { planningSessionId: string; terminalSessionId: string; sentinel: string },
): Promise<{
  visibleText: string;
  terminalSnapshotHasSentinel: boolean;
  planningSnapshotHasSentinel: boolean;
}> {
  const visibleText = await visibleTmuxText(page);
  const state = await page.evaluate(async ({ sessionId, planningId, text }) => {
    const [terminalList, chatList] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId);
    const planning = chatList.sessions.find((candidate) => candidate.id === planningId);
    return {
      terminalStatus: terminal?.status,
      terminalMode: terminal?.mode,
      terminalSnapshot: terminal?.outputSnapshot ?? '',
      planningTerminalMode: planning?.terminalMode,
      planningTerminalStatus: planning?.terminalStatus,
      planningTerminalSnapshot: planning?.terminalOutputSnapshot ?? '',
      terminalSnapshotHasSentinel: Boolean(terminal?.outputSnapshot?.includes(text)),
      planningSnapshotHasSentinel: Boolean(planning?.terminalOutputSnapshot?.includes(text)),
    };
  }, {
    sessionId: details.terminalSessionId,
    planningId: details.planningSessionId,
    text: details.sentinel,
  });

  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${scenario}.png`);
  const evidencePath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${scenario}.json`);
  await page.screenshot({ path: screenshotPath, fullPage: true });

  const evidence = {
    scenario,
    expectedBug: 'planning tmux pane is visibly blank after the switch even though the persisted terminal snapshot still contains the sentinel',
    planningSessionId: details.planningSessionId,
    terminalSessionId: details.terminalSessionId,
    sentinel: details.sentinel,
    visibleText,
    visibleTextLength: visibleText.length,
    terminalStatus: state.terminalStatus,
    terminalMode: state.terminalMode,
    planningTerminalMode: state.planningTerminalMode,
    planningTerminalStatus: state.planningTerminalStatus,
    terminalSnapshotHasSentinel: state.terminalSnapshotHasSentinel,
    planningSnapshotHasSentinel: state.planningSnapshotHasSentinel,
    terminalSnapshotTail: tail(state.terminalSnapshot),
    planningTerminalSnapshotTail: tail(state.planningTerminalSnapshot),
    screenshotPath,
  };
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await testInfo.attach(`${scenario}-tmux-blank-evidence`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  await testInfo.attach(`${scenario}-tmux-blank-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });

  return {
    visibleText,
    terminalSnapshotHasSentinel: state.terminalSnapshotHasSentinel,
    planningSnapshotHasSentinel: state.planningSnapshotHasSentinel,
  };
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank tmux panes after session switch and planning-view remount', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await configurePlanningResponse(page, planYaml);

      await openPlanningTerminal(page);
      const firstPlanningSessionId = await createDraftPlanningSession(
        page,
        'Draft a YAML plan for the first planning tmux blank repro session',
      );
      const firstTerminalSessionId = await openTmuxForActivePlanningSession(page, firstPlanningSessionId);
      await writeSentinel(page, firstTerminalSessionId, FIRST_SENTINEL);

      const secondPlanningSessionId = await createSecondDraftPlanningSession(
        page,
        'Draft a YAML plan for the second planning tmux blank repro session',
      );
      const secondTerminalSessionId = await openTmuxForActivePlanningSession(page, secondPlanningSessionId);
      await writeSentinel(page, secondTerminalSessionId, SECOND_SENTINEL);

      await selectPlanningSession(page, firstPlanningSessionId, firstTerminalSessionId);
      const switchEvidence = await captureBlankEvidence(page, testInfo, 'session-switch', {
        planningSessionId: firstPlanningSessionId,
        terminalSessionId: firstTerminalSessionId,
        sentinel: FIRST_SENTINEL,
      });
      expect(switchEvidence.terminalSnapshotHasSentinel).toBe(true);
      expect(switchEvidence.planningSnapshotHasSentinel).toBe(true);
      expect(switchEvidence.visibleText).toBe('');

      await writeSentinel(page, firstTerminalSessionId, NAVIGATION_SENTINEL);
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await expect.poll(async () => page!.evaluate(async (sessionId) => {
        const terminal = (await window.invoker.planningTerminalList()).find((candidate) => candidate.sessionId === sessionId);
        return terminal?.status;
      }, firstTerminalSessionId)).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId, { timeout: 10000 });
      const navigationEvidence = await captureBlankEvidence(page, testInfo, 'navigate-away-back', {
        planningSessionId: firstPlanningSessionId,
        terminalSessionId: firstTerminalSessionId,
        sentinel: NAVIGATION_SENTINEL,
      });
      expect(navigationEvidence.terminalSnapshotHasSentinel).toBe(true);
      expect(navigationEvidence.planningSnapshotHasSentinel).toBe(true);
      expect(navigationEvidence.visibleText).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

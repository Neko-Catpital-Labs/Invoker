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
      id: 'record-tmux-blanking',
      description: 'Record planning terminal tmux blanking',
      command: 'echo repro',
      dependencies: [],
    },
  ],
};

const FIRST_TMUX_SENTINEL = 'E2E_PLANNING_TMUX_FIRST_SESSION_SENTINEL';
const SECOND_TMUX_SENTINEL = 'E2E_PLANNING_TMUX_SECOND_SESSION_SENTINEL';
const ROUTE_TMUX_SENTINEL = 'E2E_PLANNING_TMUX_ROUTE_SESSION_SENTINEL';

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

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function bootstrapDraftPlanningSession(page: Page): Promise<string> {
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
  }, { yaml: yamlStringify(PLANNING_TMUX_BLANK_PLAN) });

  await openPlanningTerminal(page);
  await submitPlanningText(page, 'Draft a plan to reproduce planning terminal tmux blanking');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  if (!planningSessionId) throw new Error('Planning session was not created');
  return planningSessionId;
}

async function switchToTmuxMode(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.status ?? null;
  }, terminalSessionId), { timeout: 10000 }).toBe('running');
  return terminalSessionId;
}

async function switchToNewPlanningTmuxSession(page: Page, previousTerminalSessionId: string): Promise<string> {
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  await expect.poll(async () => {
    const count = await page.getByTestId('invoker-terminal-tmux-pane').count();
    if (count === 0) return '';
    const visible = await page.getByTestId('invoker-terminal-tmux-pane').isVisible().catch(() => false);
    if (!visible) return '';
    const nextSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
    return nextSessionId && nextSessionId !== previousTerminalSessionId ? nextSessionId : '';
  }, { timeout: 10000 }).not.toBe('');
  const terminalSessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Second planning tmux pane did not expose a terminal session id');
  return terminalSessionId;
}

async function writePlanningTerminalCommand(page: Page, terminalSessionId: string, command: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, data }) => (
    window.invoker.planningTerminalWrite(sessionId, data)
  ), { sessionId: terminalSessionId, data: `${command}\r` });
  expect(result).toMatchObject({ ok: true });
}

async function readPlanningTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    return (rows as HTMLElement | null)?.innerText ?? (element as HTMLElement).innerText ?? element.textContent ?? '';
  });
}

async function expectPlanningTerminalText(page: Page, expectedText: string): Promise<void> {
  await expect.poll(() => readPlanningTerminalText(page), { timeout: 10000 }).toContain(expectedText);
}

async function expectPersistedTerminalSnapshot(page: Page, terminalSessionId: string, expectedText: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ sessionId, text }) => {
    const sessions = await window.invoker.planningTerminalList();
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    return {
      status: session?.status ?? null,
      hasText: session?.outputSnapshot?.includes(text) ?? false,
    };
  }, { sessionId: terminalSessionId, text: expectedText }), { timeout: 10000 }).toEqual({
    status: 'running',
    hasText: true,
  });
}

async function attachPostSwitchEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  terminalSessionId: string,
  expectedPersistedText: string,
): Promise<{ domText: string; persistedSnapshot?: string; status?: string }> {
  const domText = await readPlanningTerminalText(page);
  const terminalSessions = await page.evaluate(async () => window.invoker.planningTerminalList());
  const planningSessions = await page.evaluate(async () => window.invoker.planningChatList());
  const terminalSession = terminalSessions.find((session) => session.sessionId === terminalSessionId);
  const planningSession = planningSessions.sessions.find((session) => session.terminalSessionId === terminalSessionId);
  const evidence = {
    label,
    terminalSessionId,
    expectedPersistedText,
    domText,
    domTextLength: domText.length,
    domTextTrimmedLength: domText.trim().length,
    terminalSession: terminalSession
      ? {
          status: terminalSession.status,
          outputSnapshot: terminalSession.outputSnapshot ?? '',
          outputSnapshotContainsExpectedText: Boolean(terminalSession.outputSnapshot?.includes(expectedPersistedText)),
        }
      : null,
    planningSession: planningSession
      ? {
          id: planningSession.id,
          terminalMode: planningSession.terminalMode,
          terminalStatus: planningSession.terminalStatus,
          terminalOutputSnapshot: planningSession.terminalOutputSnapshot ?? '',
          terminalOutputSnapshotContainsExpectedText: Boolean(
            planningSession.terminalOutputSnapshot?.includes(expectedPersistedText),
          ),
        }
      : null,
  };
  await testInfo.attach(`${label}-terminal-text.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${label}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return {
    domText,
    persistedSnapshot: terminalSession?.outputSnapshot,
    status: terminalSession?.status,
  };
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records blanking after switching planning tmux sessions and switching back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      await bootstrapDraftPlanningSession(page);

      const firstTerminalSessionId = await switchToTmuxMode(page);
      await writePlanningTerminalCommand(page, firstTerminalSessionId, `printf "${FIRST_TMUX_SENTINEL}\\n"`);
      await expectPlanningTerminalText(page, FIRST_TMUX_SENTINEL);
      await expectPersistedTerminalSnapshot(page, firstTerminalSessionId, FIRST_TMUX_SENTINEL);

      const secondTerminalSessionId = await switchToNewPlanningTmuxSession(page, firstTerminalSessionId);
      await writePlanningTerminalCommand(page, secondTerminalSessionId, `printf "${SECOND_TMUX_SENTINEL}\\n"`);
      await expectPlanningTerminalText(page, SECOND_TMUX_SENTINEL);
      await expectPersistedTerminalSnapshot(page, secondTerminalSessionId, SECOND_TMUX_SENTINEL);

      await page.getByTestId('planning-session-list').getByRole('button').nth(1).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId, { timeout: 10000 });
      await page.waitForTimeout(500);

      const evidence = await attachPostSwitchEvidence(
        page,
        testInfo,
        'planning-tmux-session-switch-back-blank',
        firstTerminalSessionId,
        FIRST_TMUX_SENTINEL,
      );
      expect(evidence.status).toBe('running');
      expect(evidence.persistedSnapshot).toContain(FIRST_TMUX_SENTINEL);
      // Current buggy behavior: the remounted pane is blank even though the
      // planning terminal session is still running and has the sentinel snapshot.
      expect(evidence.domText.trim()).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blanking after navigating away from planning tmux and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-route-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      await bootstrapDraftPlanningSession(page);

      const terminalSessionId = await switchToTmuxMode(page);
      await writePlanningTerminalCommand(page, terminalSessionId, `printf "${ROUTE_TMUX_SENTINEL}\\n"`);
      await expectPlanningTerminalText(page, ROUTE_TMUX_SENTINEL);
      await expectPersistedTerminalSnapshot(page, terminalSessionId, ROUTE_TMUX_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      await page.waitForTimeout(500);

      const evidence = await attachPostSwitchEvidence(
        page,
        testInfo,
        'planning-tmux-route-back-blank',
        terminalSessionId,
        ROUTE_TMUX_SENTINEL,
      );
      expect(evidence.status).toBe('running');
      expect(evidence.persistedSnapshot).toContain(ROUTE_TMUX_SENTINEL);
      // Current buggy behavior: route remount seeds the pane from stale UI state,
      // so the visible terminal is blank while tmux remains active in the backend.
      expect(evidence.domText.trim()).toBe('');
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

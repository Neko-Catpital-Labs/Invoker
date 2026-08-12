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
      id: 'tmux-blank-repro',
      description: 'Capture planning terminal tmux blank repro',
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

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30000 });
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
    Promise.all([closePromise, childExitPromise]).then(() => false),
    delay(5_000).then(() => true),
  ]);
  if (timedOut && !childExited) {
    child.kill('SIGTERM');
    if (child.pid && process.platform !== 'win32') {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        /* process group may already be gone */
      }
    }
    await Promise.race([childExitPromise, delay(2_000)]);
    if (!childExited) {
      child.kill('SIGKILL');
      if (child.pid && process.platform !== 'win32') {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* process group may already be gone */
        }
      }
    }
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

async function bootstrapPlanningDraft(page: Page, planYaml: string): Promise<string> {
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
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText(/draft ready/i, { timeout: 10000 });
  const sessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id;
  });
  if (!sessionId) throw new Error('Planning session was not created');
  return sessionId;
}

async function openTmuxMode(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id');
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return session?.terminalStatus;
  }, terminalSessionId), { timeout: 10000 }).toBe('running');
  return terminalSessionId;
}

async function planningSessionIdForTerminal(page: Page, terminalSessionId: string): Promise<string> {
  const planningSessionId = await page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.terminalSessionId === sessionId)?.id;
  }, terminalSessionId);
  if (!planningSessionId) throw new Error(`No planning session owns terminal ${terminalSessionId}`);
  return planningSessionId;
}

async function writePlanningTerminal(page: Page, terminalSessionId: string, command: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, data }) => {
    return window.invoker.planningTerminalWrite(sessionId, data);
  }, { sessionId: terminalSessionId, data: `${command}\n` });
  if (!result.ok) throw new Error(result.reason ?? 'planningTerminalWrite failed');
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `printf "${sentinel}\\n"`);
  await expect.poll(
    async () => terminalSnapshotForSession(page, terminalSessionId),
    { timeout: 10000 },
  ).toContain(sentinel);
  await expect.poll(
    async () => compactTerminalText(await visibleTmuxText(page)),
    { timeout: 10000 },
  ).toContain(compactTerminalText(sentinel));
}

async function terminalSnapshotForSession(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? '';
  }, terminalSessionId);
}

async function closePlanningTerminals(page: Page): Promise<void> {
  const sessionIds = await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.map((session) => session.sessionId);
  });
  for (const sessionId of sessionIds) {
    await page.evaluate(async (id) => {
      await window.invoker.planningTerminalClose(id);
    }, sessionId).catch(() => undefined);
  }
}

async function visibleTmuxText(page: Page): Promise<string> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(300);
  return pane.evaluate((node) => {
    const rows = node.querySelector('.xterm-rows');
    const rowText = Array.from(rows?.children ?? [])
      .map((row) => row.textContent ?? '')
      .join('\n');
    return rowText.replace(/\u00a0/g, ' ').trim();
  });
}

function compactTerminalText(value: string): string {
  return value.replace(/\s+/g, '');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function selectPlanningSession(page: Page, titlePrefix: string): Promise<void> {
  await page
    .getByTestId('planning-session-list')
    .getByRole('button', { name: new RegExp(escapeRegExp(titlePrefix)) })
    .click();
}

async function recordPostSwitchEvidence(
  page: Page,
  testInfo: TestInfo,
  slug: string,
  terminalText: string,
): Promise<void> {
  const textEvidence = terminalText ? `${terminalText}\n` : '<blank terminal rows>\n';
  const textPath = testInfo.outputPath(`${slug}.txt`);
  writeFileSync(textPath, textEvidence, 'utf8');
  await testInfo.attach(`${slug}-terminal-text`, {
    path: textPath,
    contentType: 'text/plain',
  });
  const screenshotPath = testInfo.outputPath(`${slug}.png`);
  await page.screenshot({
    path: screenshotPath,
    fullPage: true,
  });
  await testInfo.attach(`${slug}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
}

base.describe('Planning Terminal tmux blank regression', () => {
  base('keeps pane content after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const firstPlanningSessionId = await bootstrapPlanningDraft(page, planYaml);
      const firstTerminalSessionId = await openTmuxMode(page);
      const firstSentinel = 'TMUX_SWITCH_REPRO_SESSION_ALPHA';
      await writeSentinel(page, firstTerminalSessionId, firstSentinel);

      await page.getByRole('button', { name: 'New' }).click();
      const secondTerminalSessionId = await openTmuxMode(page);
      expect(secondTerminalSessionId).not.toBe(firstTerminalSessionId);
      const secondPlanningSessionId = await planningSessionIdForTerminal(page, secondTerminalSessionId);
      const secondSentinel = 'TMUX_SWITCH_REPRO_SESSION_BETA';
      await writeSentinel(page, secondTerminalSessionId, secondSentinel);

      await selectPlanningSession(page, 'Draft a YAML plan to reproduce planning');
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId);
      await expect.poll(
        async () => terminalSnapshotForSession(page, firstTerminalSessionId),
        { timeout: 10000 },
      ).toContain(firstSentinel);

      const returnedText = await visibleTmuxText(page);
      const compactReturnedText = compactTerminalText(returnedText);
      expect(compactReturnedText).toContain(compactTerminalText(firstSentinel));
      expect(compactReturnedText).not.toContain(compactTerminalText(secondSentinel));
      await recordPostSwitchEvidence(page, testInfo, 'planning-terminal-tmux-session-switch', returnedText);

      const planningState = await page.evaluate(async ({ firstSessionId, secondSessionId }) => {
        const list = await window.invoker.planningChatList();
        return list.sessions
          .filter((session) => session.id === firstSessionId || session.id === secondSessionId)
          .map((session) => ({
            id: session.id,
            mode: session.terminalMode,
            terminalSessionId: session.terminalSessionId,
            terminalStatus: session.terminalStatus,
            outputSnapshot: session.terminalOutputSnapshot,
          }));
      }, { firstSessionId: firstPlanningSessionId, secondSessionId: secondPlanningSessionId });
      expect(planningState).toContainEqual(expect.objectContaining({
        id: firstPlanningSessionId,
        mode: 'tmux',
        terminalSessionId: firstTerminalSessionId,
        terminalStatus: 'running',
        outputSnapshot: expect.stringContaining(firstSentinel),
      }));
      expect(planningState).toContainEqual(expect.objectContaining({
        id: secondPlanningSessionId,
        mode: 'tmux',
        terminalSessionId: secondTerminalSessionId,
        terminalStatus: 'running',
        outputSnapshot: expect.stringContaining(secondSentinel),
      }));
    } finally {
      if (page) await closePlanningTerminals(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('keeps pane content after navigating away and back while planning tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      page = launched.page;
      const planningSessionId = await bootstrapPlanningDraft(page, planYaml);
      const terminalSessionId = await openTmuxMode(page);
      const sentinel = 'TMUX_NAV_REPRO_STILL_ACTIVE';
      await writeSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(
        async () => terminalSnapshotForSession(page, terminalSessionId),
        { timeout: 10000 },
      ).toContain(sentinel);
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);

      const returnedText = await visibleTmuxText(page);
      expect(compactTerminalText(returnedText)).toContain(compactTerminalText(sentinel));
      await recordPostSwitchEvidence(page, testInfo, 'planning-terminal-tmux-navigation', returnedText);

      await expect.poll(async () => page.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return {
          mode: session?.terminalMode,
          terminalSessionId: session?.terminalSessionId,
          terminalStatus: session?.terminalStatus,
          outputSnapshot: session?.terminalOutputSnapshot,
        };
      }, planningSessionId), { timeout: 10000 }).toEqual(expect.objectContaining({
        mode: 'tmux',
        terminalSessionId,
        terminalStatus: 'running',
        outputSnapshot: expect.stringContaining(sentinel),
      }));
    } finally {
      if (page) await closePlanningTerminals(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

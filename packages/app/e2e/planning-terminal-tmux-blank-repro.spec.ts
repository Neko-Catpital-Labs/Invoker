import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const ALPHA_PROMPT = 'Draft a YAML plan for alpha planning terminal blank repro';
const BETA_PROMPT = 'Draft a YAML plan for beta planning terminal blank repro';
const ALPHA_REPLY = 'Alpha blank repro draft is ready.';
const BETA_REPLY = 'Beta blank repro draft is ready.';
const ALPHA_SENTINEL = 'PTMUX_ALPHA_SENTINEL';
const BETA_SENTINEL = 'PTMUX_BETA_SENTINEL';
const ALPHA_NAV_SENTINEL = 'PTMUX_ALPHA_NAV_SENTINEL';

function reproPlan(planName: string) {
  return {
    name: planName,
    onFinish: 'none' as const,
    tasks: [
      {
        id: 'terminal-blank-repro',
        description: 'Terminal blank repro',
        command: 'echo blank-repro',
        dependencies: [],
      },
    ],
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

async function ensurePlanningRailExpanded(page: Page): Promise<void> {
  const expandRail = page.getByRole('button', { name: 'Expand planning chats' });
  if (await expandRail.isVisible().catch(() => false)) {
    await expandRail.click();
  }
  await expect(page.getByTestId('planning-session-list')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function setPlanningResponse(page: Page, planName: string, reply: string): Promise<void> {
  await page.evaluate(async ({ planYaml, planName: responsePlanName, reply: responseReply }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml,
      planName: responsePlanName,
      reply: responseReply,
    });
  }, {
    planYaml: yamlStringify(reproPlan(planName)),
    planName,
    reply,
  });
}

async function createPlanningSession(page: Page, prompt: string, reply: string, planName: string): Promise<string> {
  await setPlanningResponse(page, planName, reply);
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (expectedPrompt) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => (
      session.messages.some((message) => message.text.includes(expectedPrompt))
    ))?.id ?? null;
  }, prompt);
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function switchPlanningSessionByReply(page: Page, reply: string, expectedTerminalSessionId: string): Promise<void> {
  await ensurePlanningRailExpanded(page);
  await page.getByTestId('planning-session-list').getByRole('button').filter({ hasText: reply }).click();
  await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', expectedTerminalSessionId, { timeout: 10000 });
}

async function openTmuxMode(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async ({ sessionId, planningId }) => {
    const terminalList = await window.invoker.planningTerminalList();
    const planningList = await window.invoker.planningChatList();
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId);
    const planning = planningList.sessions.find((candidate) => candidate.id === planningId);
    return {
      terminalStatus: terminal?.status,
      planningMode: planning?.terminalMode,
      planningTerminalSessionId: planning?.terminalSessionId,
    };
  }, { sessionId: terminalSessionId, planningId: planningSessionId })).toEqual({
    terminalStatus: 'running',
    planningMode: 'tmux',
    planningTerminalSessionId: terminalSessionId,
  });
  return terminalSessionId!;
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function terminalText(page: Page): Promise<string> {
  return normalizeTerminalText(await page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    return rows?.textContent ?? '';
  }));
}

async function terminalRecord(page: Page, terminalSessionId: string) {
  return page.evaluate(async (sessionId) => {
    const terminalList = await window.invoker.planningTerminalList();
    const planningList = await window.invoker.planningChatList();
    const terminal = terminalList.find((candidate) => candidate.sessionId === sessionId) ?? null;
    const planning = planningList.sessions.find((candidate) => candidate.terminalSessionId === sessionId) ?? null;
    return {
      terminal,
      planning: planning
        ? {
            id: planning.id,
            terminalMode: planning.terminalMode,
            terminalSessionId: planning.terminalSessionId,
            terminalStatus: planning.terminalStatus,
            terminalOutputSnapshot: planning.terminalOutputSnapshot ?? '',
          }
        : null,
    };
  }, terminalSessionId);
}

async function waitForTerminalSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => terminalText(page), { timeout: 10000 }).toContain(sentinel);
  await expect.poll(async () => {
    const record = await terminalRecord(page, terminalSessionId);
    return record.terminal?.outputSnapshot ?? '';
  }, { timeout: 10000 }).toContain(sentinel);
}

async function writeTerminalSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, command }) => {
    return window.invoker.planningTerminalWrite(sessionId, command);
  }, {
    sessionId: terminalSessionId,
    command: `printf "${sentinel}\\n"\r`,
  });
  expect(result).toMatchObject({ ok: true });
  await waitForTerminalSentinel(page, terminalSessionId, sentinel);
}

async function recordBlankEvidence(testInfo: TestInfo, page: Page, label: string, terminalSessionId: string) {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await pane.screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-screenshot`, { path: screenshotPath, contentType: 'image/png' });

  const text = await terminalText(page);
  const record = await terminalRecord(page, terminalSessionId);
  const textPath = testInfo.outputPath(`${label}.txt`);
  writeFileSync(
    textPath,
    [
      `label=${label}`,
      `uiText=${text || '<blank>'}`,
      `terminalStatus=${record.terminal?.status ?? '<missing>'}`,
      `terminalOutputSnapshot=${record.terminal?.outputSnapshot ?? '<empty>'}`,
      `planningTerminalStatus=${record.planning?.terminalStatus ?? '<missing>'}`,
      `planningTerminalOutputSnapshot=${record.planning?.terminalOutputSnapshot ?? '<empty>'}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await testInfo.attach(`${label}-text`, { path: textPath, contentType: 'text/plain' });
  return { text, record };
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records blank pane after tmux session switch and planning view remount', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });

      await openPlanningTerminal(page);
      await ensurePlanningRailExpanded(page);

      const alphaPlanningSessionId = await createPlanningSession(page, ALPHA_PROMPT, ALPHA_REPLY, 'Planning Terminal Tmux Blank Alpha');
      const alphaTerminalSessionId = await openTmuxMode(page, alphaPlanningSessionId);
      await writeTerminalSentinel(page, alphaTerminalSessionId, ALPHA_SENTINEL);

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      const betaPlanningSessionId = await createPlanningSession(page, BETA_PROMPT, BETA_REPLY, 'Planning Terminal Tmux Blank Beta');
      const betaTerminalSessionId = await openTmuxMode(page, betaPlanningSessionId);
      await writeTerminalSentinel(page, betaTerminalSessionId, BETA_SENTINEL);

      await switchPlanningSessionByReply(page, ALPHA_REPLY, alphaTerminalSessionId);
      const sessionSwitchEvidence = await recordBlankEvidence(testInfo, page, 'planning-tmux-session-switch-blank', alphaTerminalSessionId);
      expect(sessionSwitchEvidence.record.terminal?.status).toBe('running');
      expect(sessionSwitchEvidence.record.terminal?.outputSnapshot).toContain(ALPHA_SENTINEL);
      expect(sessionSwitchEvidence.text).toBe('');
      expect(sessionSwitchEvidence.text).not.toContain(ALPHA_SENTINEL);

      await writeTerminalSentinel(page, alphaTerminalSessionId, ALPHA_NAV_SENTINEL);
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });

      const navigationEvidence = await recordBlankEvidence(testInfo, page, 'planning-tmux-navigation-blank', alphaTerminalSessionId);
      expect(navigationEvidence.record.terminal?.status).toBe('running');
      expect(navigationEvidence.record.terminal?.outputSnapshot).toContain(ALPHA_NAV_SENTINEL);
      expect(navigationEvidence.text).toBe('');
      expect(navigationEvidence.text).not.toContain(ALPHA_NAV_SENTINEL);

      expect(betaPlanningSessionId).toBeTruthy();
      expect(betaTerminalSessionId).toBeTruthy();
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

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
      description: 'Reproduce planning terminal tmux blanking',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

const FIRST_PROMPT = 'Draft a YAML plan for planning tmux session one';
const SECOND_PROMPT = 'Draft a YAML plan for planning tmux session two';
const FIRST_SENTINEL = 'INVOKER_PLANNING_TMUX_SESSION_ONE_SENTINEL';
const SECOND_SENTINEL = 'INVOKER_PLANNING_TMUX_SESSION_TWO_SENTINEL';
const NAV_SENTINEL = 'INVOKER_PLANNING_TMUX_NAV_SENTINEL';

type PlanningTerminalSessionView = {
  sessionId: string;
  status?: string;
  outputSnapshot?: string;
};

type TerminalEvidence = {
  visibleText: string;
  normalizedVisibleText: string;
  outputSnapshot: string;
  status?: string;
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

async function bootstrapDraftPlanningSession(page: Page, prompt: string, planYaml: string): Promise<void> {
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
}

async function openTmuxForActivePlanningSession(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  return sessionId ?? '';
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    async ({ targetSessionId, input }) => window.invoker.planningTerminalWrite(targetSessionId, input),
    { targetSessionId: sessionId, input: data },
  );
  expect(result).toMatchObject({ ok: true });
}

async function terminalVisibleText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((node) => {
    const host = node as HTMLElement;
    const rows = host.querySelector('.xterm-rows') as HTMLElement | null;
    const screen = host.querySelector('.xterm-screen') as HTMLElement | null;
    return (rows?.innerText ?? rows?.textContent ?? screen?.innerText ?? host.innerText ?? host.textContent ?? '').replace(/\r/g, '');
  });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').trim();
}

async function planningTerminalSession(page: Page, sessionId: string): Promise<PlanningTerminalSessionView | undefined> {
  const sessions = await page.evaluate(() => window.invoker.planningTerminalList());
  return sessions.find((session) => session.sessionId === sessionId);
}

async function terminalOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return (await planningTerminalSession(page, sessionId))?.outputSnapshot ?? '';
}

async function writeSentinelAndWait(page: Page, sessionId: string, sentinel: string): Promise<void> {
  await writePlanningTerminal(page, sessionId, `printf '%s\\n' ${shellQuote(sentinel)}\n`);
  await expect.poll(
    () => terminalOutputSnapshot(page, sessionId),
    { timeout: 10000, message: `terminal snapshot should contain ${sentinel}` },
  ).toContain(sentinel);
  await expect.poll(
    () => terminalVisibleText(page),
    { timeout: 10000, message: `visible terminal text should contain ${sentinel} before switching` },
  ).toContain(sentinel);
}

async function clickPlanningSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('planning-session-list').getByRole('button').filter({ hasText: title }).first().click();
}

async function captureTerminalEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  sessionId: string,
): Promise<TerminalEvidence> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane).toHaveAttribute('data-session-id', sessionId);
  const visibleText = await terminalVisibleText(page);
  const session = await planningTerminalSession(page, sessionId);
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  await pane.screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  const evidence = {
    label,
    sessionId,
    visibleText,
    normalizedVisibleText: normalizeTerminalText(visibleText),
    session,
  };
  await testInfo.attach(`${label}-terminal-text`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  return {
    visibleText,
    normalizedVisibleText: evidence.normalizedVisibleText,
    outputSnapshot: session?.outputSnapshot ?? '',
    status: session?.status,
  };
}

function expectBuggyBlankTerminal(evidence: TerminalEvidence, sentinel: string): void {
  expect(evidence.status).toBe('running');
  expect(evidence.outputSnapshot).toContain(sentinel);
  // Repro slice: assert the observed defect before the root-cause fix. When fixed,
  // these assertions should flip to require the sentinel in visible terminal text.
  expect(evidence.visibleText).not.toContain(sentinel);
  expect(evidence.normalizedVisibleText).toBe('');
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records blank pane after switching between planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-session-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
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
      await bootstrapDraftPlanningSession(page, FIRST_PROMPT, planYaml);
      const firstTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeSentinelAndWait(page, firstTerminalSessionId, FIRST_SENTINEL);

      await page.getByRole('button', { name: 'New chat' }).click();
      await bootstrapDraftPlanningSession(page, SECOND_PROMPT, planYaml);
      const secondTerminalSessionId = await openTmuxForActivePlanningSession(page);
      expect(secondTerminalSessionId).not.toBe(firstTerminalSessionId);
      await writeSentinelAndWait(page, secondTerminalSessionId, SECOND_SENTINEL);

      await clickPlanningSession(page, FIRST_PROMPT);
      const evidence = await captureTerminalEvidence(page, testInfo, 'planning-tmux-session-switch-blank', firstTerminalSessionId);

      expectBuggyBlankTerminal(evidence, FIRST_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank pane after navigating away and back while tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-navigation-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
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
      await bootstrapDraftPlanningSession(page, FIRST_PROMPT, planYaml);
      const terminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeSentinelAndWait(page, terminalSessionId, NAV_SENTINEL);

      await page.getByTestId('sidebar-workers').click();
      await expect(page.getByTestId('workers-rail')).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();

      const evidence = await captureTerminalEvidence(page, testInfo, 'planning-tmux-navigation-blank', terminalSessionId);

      expectBuggyBlankTerminal(evidence, NAV_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { E2E_BROWSER_REGISTRY_ENV, registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const CLEANUP_CHROME_SCRIPT = path.resolve(__dirname, '..', '..', '..', 'scripts', 'cleanup-orphaned-automation-chrome.mjs');

const PLANNING_TMUX_BLANK_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Record planning terminal tmux blanking',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

const ALPHA_MESSAGE = 'Draft planning tmux blank alpha plan';
const BETA_TITLE = 'Planning tmux blank beta plan';
const ALPHA_SESSION_SENTINEL = 'TMUX_BLANK_REPRO_ALPHA_SESSION_SWITCH_SENTINEL';
const BETA_SESSION_SENTINEL = 'TMUX_BLANK_REPRO_BETA_SESSION_SWITCH_SENTINEL';
const ALPHA_NAV_SENTINEL = 'TMUX_BLANK_REPRO_ALPHA_NAVIGATION_SENTINEL';

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

function cleanupTrackedBrowserProcesses(): void {
  const registryPath = process.env[E2E_BROWSER_REGISTRY_ENV];
  if (!registryPath) return;
  execFileSync(process.execPath, [CLEANUP_CHROME_SCRIPT, '--registry', registryPath], { stdio: 'inherit' });
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function createNamedPlanningSession(page: Page, title: string): Promise<{ id: string; title: string }> {
  const result = await page.evaluate(async ({ sessionTitle }) => {
    const response = await window.invoker.planningChatCreate({
      title: sessionTitle,
      confirmationMode: 'require',
    });
    if (!response.ok) throw new Error(response.error);
    return {
      id: response.session.id,
      title: response.session.title,
    };
  }, { sessionTitle: title });
  expect(result.id).toBeTruthy();
  return result;
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  const list = page.getByTestId('planning-session-list');
  await list.getByText(title, { exact: true }).click();
  await expect(page.locator('main')).toContainText(title, { timeout: 10000 });
}

async function openTmuxForActivePlanningSession(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async ({ sessionId, expectedTerminalSessionId }) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return {
      mode: session?.terminalMode,
      terminalSessionId: session?.terminalSessionId,
      terminalStatus: session?.terminalStatus,
      visibleTerminalSessionId: expectedTerminalSessionId,
    };
  }, { sessionId: planningSessionId, expectedTerminalSessionId: terminalSessionId })).toEqual({
    mode: 'tmux',
    terminalSessionId,
    terminalStatus: 'running',
    visibleTerminalSessionId: terminalSessionId,
  });
  return terminalSessionId ?? '';
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, command }) => {
    return window.invoker.planningTerminalWrite(sessionId, command);
  }, {
    sessionId: terminalSessionId,
    command: `printf '${sentinel}\\n'\n`,
  });
  expect(result).toEqual({ ok: true });
  await expect.poll(async () => page.evaluate(async ({ sessionId, expected }) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.terminalSessionId === sessionId);
    return session?.terminalOutputSnapshot?.includes(expected) ?? false;
  }, { sessionId: terminalSessionId, expected: sentinel })).toBe(true);
  await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function getRenderedTmuxText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    return (element as HTMLElement).innerText || element.textContent || '';
  });
}

function normalizedTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function captureBlankEvidence(page: Page, testInfo: TestInfo, options: {
  label: string;
  planningSessionId: string;
  sentinel: string;
  screenshotName: string;
}): Promise<void> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  const renderedText = await getRenderedTmuxText(page);
  const normalizedRenderedText = normalizedTerminalText(renderedText);
  const summary = await page.evaluate(async ({ sessionId }) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((candidate) => candidate.id === sessionId) ?? null;
  }, { sessionId: options.planningSessionId });
  const outputSnapshot = summary?.terminalOutputSnapshot ?? '';
  const screenshotPath = testInfo.outputPath(options.screenshotName);

  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${options.label}-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });

  const evidence = {
    label: options.label,
    planningSessionId: options.planningSessionId,
    terminalSessionId,
    sentinel: options.sentinel,
    renderedText: normalizedRenderedText,
    outputSnapshotTail: outputSnapshot.slice(-500),
    screenshotPath,
  };
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify(evidence)}`);
  expect(outputSnapshot, JSON.stringify(evidence)).toContain(options.sentinel);
  expect(normalizedRenderedText, JSON.stringify(evidence)).toBe('');
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank panes after planning tmux session switches and navigation', async ({}, testInfo) => {
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
      await page.evaluate(async ({ yaml }) => {
        await window.invoker.setTestPlanningChatResponse({
          planYaml: yaml,
          planName: 'Planning Terminal Tmux Blank Repro',
          reply: 'I drafted the tmux blank repro plan.',
        });
      }, { yaml: planYaml });

      await openPlanningTerminal(page);
      await submitPlanningText(page, ALPHA_MESSAGE);
      await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
      const alphaSession = await page.evaluate(async () => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions[0];
        if (!session) throw new Error('Alpha planning session was not created.');
        return { id: session.id, title: session.title };
      });
      const betaSession = await createNamedPlanningSession(page, BETA_TITLE);

      await page.reload();
      await waitForInvoker(page);
      await openPlanningTerminal(page);
      await expect(page.getByTestId('planning-session-list')).toContainText(alphaSession.title, { timeout: 10000 });
      await expect(page.getByTestId('planning-session-list')).toContainText(betaSession.title);

      await selectPlanningSession(page, alphaSession.title);
      const alphaTerminalSessionId = await openTmuxForActivePlanningSession(page, alphaSession.id);
      await writeSentinel(page, alphaTerminalSessionId, ALPHA_SESSION_SENTINEL);

      await selectPlanningSession(page, betaSession.title);
      const betaTerminalSessionId = await openTmuxForActivePlanningSession(page, betaSession.id);
      await writeSentinel(page, betaTerminalSessionId, BETA_SESSION_SENTINEL);

      await selectPlanningSession(page, alphaSession.title);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });
      await captureBlankEvidence(page, testInfo, {
        label: 'planning-session-switch-back',
        planningSessionId: alphaSession.id,
        sentinel: ALPHA_SESSION_SENTINEL,
        screenshotName: 'visual-proof-planning-terminal-tmux-session-switch-blank-repro.png',
      });

      await writeSentinel(page, alphaTerminalSessionId, ALPHA_NAV_SENTINEL);
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0, { timeout: 10000 });
      await expect.poll(async () => page.evaluate(async ({ sessionId }) => {
        const sessions = await window.invoker.planningTerminalList();
        return sessions.find((session) => session.sessionId === sessionId)?.status ?? null;
      }, { sessionId: alphaTerminalSessionId })).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });
      await captureBlankEvidence(page, testInfo, {
        label: 'planning-terminal-navigation-back',
        planningSessionId: alphaSession.id,
        sentinel: ALPHA_NAV_SENTINEL,
        screenshotName: 'visual-proof-planning-terminal-tmux-navigation-blank-repro.png',
      });
    } finally {
      if (page) {
        await page.evaluate(async () => {
          const sessions = await window.invoker.planningTerminalList();
          await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
        }).catch(() => undefined);
      }
      if (app) await closeApp(app).catch(() => undefined);
      cleanupTrackedBrowserProcesses();
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

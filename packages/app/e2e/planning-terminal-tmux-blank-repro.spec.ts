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
      description: 'Capture planning tmux blanking repro',
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
  const markChildExited = () => {
    childExited = true;
  };
  const childExitPromise = new Promise<void>((resolve) => {
    const markAndResolve = () => {
      markChildExited();
      resolve();
    };
    child.once('exit', markAndResolve);
    child.once('close', markAndResolve);
  });

  const waitForExit = async (timeoutMs: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) {
      markChildExited();
      return true;
    }
    await Promise.race([childExitPromise, delay(timeoutMs)]);
    if (child.exitCode !== null || child.signalCode !== null) {
      markChildExited();
    }
    return childExited;
  };

  const signalProcessGroup = (signal: NodeJS.Signals): void => {
    try {
      if (process.platform !== 'win32' && typeof child.pid === 'number') {
        process.kill(-child.pid, signal);
        return;
      }
    } catch {
      // Fall back to the direct child below.
    }
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  };

  await Promise.race([
    app.close().catch(() => undefined),
    delay(3_000),
  ]);
  if (await waitForExit(2_000)) return;

  await Promise.race([
    app.evaluate(({ app: electronApp }) => {
      electronApp.exit(0);
    }).catch(() => undefined),
    delay(1_000),
  ]);
  if (await waitForExit(2_000)) return;

  signalProcessGroup('SIGTERM');
  if (await waitForExit(2_000)) return;

  if (!childExited) {
    signalProcessGroup('SIGKILL');
    await waitForExit(2_000);
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

async function bootstrapPlanningApp(): Promise<{
  app: ElectronApplication;
  page: Page;
  testDir: string;
}> {
  const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
  const configPath = path.join(testDir, 'e2e-config.json');
  const userDataDir = path.join(testDir, 'electron-user-data');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

  const { app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
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
  return { app, page, testDir };
}

async function createDraftReadyPlanningSession(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect.poll(async () => {
    const list = await page.evaluate(async (title) => {
      const response = await window.invoker.planningChatList();
      const session = response.sessions.find((candidate) => candidate.title === title);
      return session ? { id: session.id, status: session.status } : null;
    }, prompt);
    return list?.status ?? null;
  }, { timeout: 10000 }).toBe('draft_ready');
  const sessionId = await page.evaluate(async (title) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.title === title)?.id ?? null;
  }, prompt);
  if (!sessionId) throw new Error(`Planning session "${prompt}" was not persisted`);
  return sessionId;
}

async function createNewPlanningChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('planning-session-list').locator(`[title="${title}"]`).click();
}

async function openTmuxForActivePlanningSession(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane did not expose a session id');
  return sessionId;
}

async function visibleTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rows = pane.querySelector('.xterm-rows') as HTMLElement | null;
    return (rows?.innerText ?? (pane as HTMLElement).innerText ?? '').replace(/\u00a0/g, ' ');
  });
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, text }) => {
    return window.invoker.planningTerminalWrite(sessionId, `printf '${text}\\n'\n`);
  }, { sessionId: terminalSessionId, text: sentinel });
  expect(result.ok).toBe(true);
  await expect.poll(() => visibleTerminalText(page), { timeout: 10000 }).toContain(sentinel);
  await expect.poll(async () => backendSnapshotForSession(page, terminalSessionId), { timeout: 10000 }).toContain(sentinel);
}

async function backendSnapshotForSession(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? '';
  }, terminalSessionId);
}

async function expectBackendStillHasSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const snapshot = await backendSnapshotForSession(page, terminalSessionId);
  expect(snapshot).toContain(sentinel);
  const state = await page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    return session ? { status: session.status, outputSnapshot: session.outputSnapshot } : null;
  }, terminalSessionId);
  expect(state?.status).toBe('running');
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  const sessions = await page.evaluate(async () => window.invoker.planningTerminalList());
  await Promise.all(sessions.map((session) => (
    page.evaluate(async (sessionId) => window.invoker.planningTerminalClose(sessionId), session.sessionId)
  )));
  await expect.poll(async () => {
    const remaining = await page.evaluate(async () => window.invoker.planningTerminalList());
    return remaining.length;
  }, { timeout: 5000 }).toBe(0);
}

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  screenshotName: string,
): Promise<string> {
  const text = await visibleTerminalText(page);
  await testInfo.attach(`${label}-terminal-text.txt`, {
    body: text,
    contentType: 'text/plain',
  });
  const screenshotPath = testInfo.outputPath(screenshotName);
  await page.getByTestId('invoker-terminal-tmux-pane').screenshot({ path: screenshotPath });
  await testInfo.attach(`${label}-terminal.png`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  return text;
}

base.describe('Planning terminal tmux blank repro', () => {
  base('documents blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let testDir: string | undefined;
    try {
      const launched = await bootstrapPlanningApp();
      app = launched.app;
      page = launched.page;
      testDir = launched.testDir;

      const alphaTitle = 'Draft a YAML plan for tmux blank repro alpha';
      const betaTitle = 'Draft a YAML plan for tmux blank repro beta';
      const alphaSentinel = 'PLANNING_TMUX_SESSION_SWITCH_ALPHA_SENTINEL';
      const betaSentinel = 'PLANNING_TMUX_SESSION_SWITCH_BETA_SENTINEL';

      const alphaPlanningSessionId = await createDraftReadyPlanningSession(page, alphaTitle);
      const alphaTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId);
      await writeSentinel(page, alphaTerminalSessionId, alphaSentinel);

      await createNewPlanningChat(page);
      const betaPlanningSessionId = await createDraftReadyPlanningSession(page, betaTitle);
      const betaTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', betaTerminalSessionId);
      await writeSentinel(page, betaTerminalSessionId, betaSentinel);

      await selectPlanningSession(page, alphaTitle);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });
      await expectBackendStillHasSentinel(page, alphaTerminalSessionId, alphaSentinel);

      const postSwitchText = await captureBlankEvidence(
        page,
        testInfo,
        'session-switch',
        'visual-proof-planning-terminal-tmux-blank-session-switch.png',
      );
      expect(normalizeTerminalText(postSwitchText), 'current bug: remounted alpha tmux pane is blank after switching back from beta').toBe('');
      expect(postSwitchText).not.toContain(alphaSentinel);

      await expect.poll(async () => {
        const list = await page.evaluate(async () => window.invoker.planningChatList());
        return list.sessions
          .filter((session) => session.id === alphaPlanningSessionId || session.id === betaPlanningSessionId)
          .map((session) => ({
            id: session.id,
            mode: session.terminalMode,
            terminalStatus: session.terminalStatus,
          }));
      }).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: alphaPlanningSessionId, mode: 'tmux', terminalStatus: 'running' }),
        expect.objectContaining({ id: betaPlanningSessionId, mode: 'tmux', terminalStatus: 'running' }),
      ]));
    } finally {
      if (page) await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      if (testDir) rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('documents blank pane after navigating away and back while planning tmux remains active', async ({}, testInfo) => {
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let testDir: string | undefined;
    try {
      const launched = await bootstrapPlanningApp();
      app = launched.app;
      page = launched.page;
      testDir = launched.testDir;

      const title = 'Draft a YAML plan for tmux blank repro navigation';
      const sentinel = 'PLANNING_TMUX_NAVIGATION_SENTINEL';

      const planningSessionId = await createDraftReadyPlanningSession(page, title);
      const terminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expectBackendStillHasSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      await expectBackendStillHasSentinel(page, terminalSessionId, sentinel);

      const postNavigationText = await captureBlankEvidence(
        page,
        testInfo,
        'navigation-switch',
        'visual-proof-planning-terminal-tmux-blank-navigation.png',
      );
      expect(normalizeTerminalText(postNavigationText), 'current bug: remounted planning tmux pane is blank after navigating back').toBe('');
      expect(postNavigationText).not.toContain(sentinel);

      await expect.poll(async () => {
        const list = await page.evaluate(async () => window.invoker.planningChatList());
        const session = list.sessions.find((candidate) => candidate.id === planningSessionId);
        return {
          mode: session?.terminalMode,
          terminalSessionId: session?.terminalSessionId,
          terminalStatus: session?.terminalStatus,
        };
      }).toEqual({
        mode: 'tmux',
        terminalSessionId,
        terminalStatus: 'running',
      });
    } finally {
      if (page) await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      if (testDir) rmSync(testDir, { recursive: true, force: true });
    }
  });
});

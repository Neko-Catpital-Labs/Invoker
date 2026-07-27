import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const PLANNING_TMUX_BLANK_REPRO_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Record planning terminal tmux blank repro',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

type TmuxEvidence = {
  path: 'session-switch' | 'view-navigation';
  terminalSessionId: string;
  sentinel: string;
  visibleText: string;
  backendSnapshot: string;
  screenshotPath: string;
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

async function bootstrapPlanningHarness(page: Page, planYaml: string): Promise<void> {
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
}

async function createDraftReadyPlanningSession(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (message) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.messages.some((line) => line.text === message))?.id ?? null;
  }, prompt);
  if (!sessionId) throw new Error(`Planning session for "${prompt}" was not persisted.`);
  return sessionId;
}

async function openTmuxForActivePlanningSession(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('Planning tmux pane did not expose a terminal session id.');
  await expect.poll(async () => {
    const sessions = await page.evaluate(() => window.invoker.planningTerminalList());
    return sessions.find((session) => session.sessionId === terminalSessionId)?.status;
  }).toBe('running');
  return terminalSessionId;
}

async function writeTmuxSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, text }) => {
    return window.invoker.planningTerminalWrite(sessionId, `printf '${text}\\n'\n`);
  }, { sessionId: terminalSessionId, text: sentinel });
  expect(result).toMatchObject({ ok: true });
  await expect.poll(() => visibleTmuxText(page), {
    timeout: 10000,
  }).toContain(sentinel);
}

async function visibleTmuxText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rows = pane.querySelector('.xterm-rows');
    return (rows?.textContent ?? pane.textContent ?? '').replace(/\u00a0/g, ' ');
  });
}

async function backendSnapshotFor(page: Page, terminalSessionId: string): Promise<string> {
  const snapshot = await page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? null;
  }, terminalSessionId);
  if (snapshot === null) throw new Error(`Planning terminal session "${terminalSessionId}" was not found.`);
  return snapshot;
}

async function closePlanningTerminals(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId).catch(() => undefined)));
  }).catch(() => undefined);
}

async function recordBlankEvidence(
  page: Page,
  pathName: TmuxEvidence['path'],
  terminalSessionId: string,
  sentinel: string,
): Promise<TmuxEvidence> {
  const visibleText = await visibleTmuxText(page);
  const backendSnapshot = await backendSnapshotFor(page, terminalSessionId);
  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${pathName}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  const evidence = {
    path: pathName,
    terminalSessionId,
    sentinel,
    visibleText,
    backendSnapshot,
    screenshotPath,
  };
  writeFileSync(
    path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${pathName}.json`),
    `${JSON.stringify(evidence, null, 2)}\n`,
    'utf8',
  );
  return evidence;
}

function expectCurrentlyBlank(evidence: TmuxEvidence): void {
  expect(evidence.backendSnapshot).toContain(evidence.sentinel);
  expect(evidence.visibleText).not.toContain(evidence.sentinel);
  expect(evidence.visibleText.trim()).toBe('');
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank tmux pane after switching planning tmux sessions and back', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-session-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapPlanningHarness(page, planYaml);
      await openPlanningTerminal(page);

      const firstPrompt = 'Draft first tmux blank repro plan';
      const firstPlanningSessionId = await createDraftReadyPlanningSession(page, firstPrompt);
      const firstTerminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeTmuxSentinel(page, firstTerminalSessionId, 'TMUX_BLANK_REPRO_SESSION_ALPHA');

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      const secondPrompt = 'Draft second tmux blank repro plan';
      const secondPlanningSessionId = await createDraftReadyPlanningSession(page, secondPrompt);
      const secondTerminalSessionId = await openTmuxForActivePlanningSession(page);
      expect(secondTerminalSessionId).not.toBe(firstTerminalSessionId);
      await writeTmuxSentinel(page, secondTerminalSessionId, 'TMUX_BLANK_REPRO_SESSION_BETA');

      await page.getByTestId('planning-session-list').getByText(firstPrompt, { exact: true }).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', firstTerminalSessionId, { timeout: 10000 });
      await expect.poll(async () => {
        const list = await page!.evaluate(() => window.invoker.planningChatList());
        return list.sessions.find((session) => session.id === firstPlanningSessionId)?.terminalSessionId;
      }).toBe(firstTerminalSessionId);
      await expect.poll(async () => {
        const list = await page!.evaluate(() => window.invoker.planningChatList());
        return list.sessions.find((session) => session.id === secondPlanningSessionId)?.terminalSessionId;
      }).toBe(secondTerminalSessionId);

      const evidence = await recordBlankEvidence(
        page,
        'session-switch',
        firstTerminalSessionId,
        'TMUX_BLANK_REPRO_SESSION_ALPHA',
      );
      expectCurrentlyBlank(evidence);
    } finally {
      if (page) await closePlanningTerminals(page);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blank tmux pane after navigating away and back while tmux stays active', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-navigation-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapPlanningHarness(page, planYaml);
      await openPlanningTerminal(page);

      await createDraftReadyPlanningSession(page, 'Draft navigation tmux blank repro plan');
      const terminalSessionId = await openTmuxForActivePlanningSession(page);
      await writeTmuxSentinel(page, terminalSessionId, 'TMUX_BLANK_REPRO_NAVIGATION');

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => {
        const sessions = await page!.evaluate(() => window.invoker.planningTerminalList());
        return sessions.find((session) => session.sessionId === terminalSessionId)?.status;
      }).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });

      const evidence = await recordBlankEvidence(
        page,
        'view-navigation',
        terminalSessionId,
        'TMUX_BLANK_REPRO_NAVIGATION',
      );
      expectCurrentlyBlank(evidence);
    } finally {
      if (page) await closePlanningTerminals(page);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

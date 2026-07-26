import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
      description: 'Capture the planning tmux blank repro',
      command: 'echo tmux-blank-repro',
      dependencies: [],
    },
  ],
};

type PlanningTerminalDescriptor = {
  sessionId: string;
  planningSessionId?: string;
  status: 'running' | 'exited';
  outputSnapshot?: string;
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

function findBrowserProcessIdsForUserDataDir(userDataDir: string): number[] {
  let stdout = '';
  try {
    stdout = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
  } catch {
    return [];
  }
  return stdout
    .split('\n')
    .map((line) => {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      if (!match) return null;
      return {
        pid: Number.parseInt(match[1], 10),
        command: match[2],
      };
    })
    .filter((row): row is { pid: number; command: string } => (
      Boolean(row)
      && row.command.includes(`--user-data-dir=${userDataDir}`)
    ))
    .map((row) => row.pid);
}

async function cleanupBrowserProcessesForUserDataDir(userDataDir: string): Promise<void> {
  const terminate = (signal: NodeJS.Signals): void => {
    for (const pid of findBrowserProcessIdsForUserDataDir(userDataDir)) {
      try {
        process.kill(pid, signal);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
      }
    }
  };
  terminate('SIGTERM');
  await delay(500);
  terminate('SIGKILL');
}

async function closeApp(app: ElectronApplication, userDataDir: string): Promise<void> {
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
  await cleanupBrowserProcessesForUserDataDir(userDataDir);
}

async function openPlanningTerminal(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function createDraftPlanningSession(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  await expect.poll(async () => page.evaluate(async (title) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.title === title)?.id ?? null;
  }, prompt), { timeout: 10000 }).toBeTruthy();
  const sessionId = await page.evaluate(async (title) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.title === title)?.id ?? null;
  }, prompt);
  if (!sessionId) throw new Error(`Planning session "${prompt}" was not created`);
  return sessionId;
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  const sessionButton = page
    .getByTestId('planning-session-list')
    .locator('button')
    .filter({ hasText: title })
    .first();
  await sessionButton.click();
}

async function openTmuxForPlanningSession(page: Page, planningSessionId: string): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  expect(terminalSessionId).toBeTruthy();
  await expect.poll(async () => page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    const session = list.sessions.find((candidate) => candidate.id === sessionId);
    return {
      mode: session?.terminalMode,
      terminalSessionId: session?.terminalSessionId,
      terminalStatus: session?.terminalStatus,
    };
  }, planningSessionId), { timeout: 10000 }).toEqual({
    mode: 'tmux',
    terminalSessionId,
    terminalStatus: 'running',
  });
  return terminalSessionId ?? '';
}

async function writeSentinel(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(async ({ sessionId, text }) => {
    return window.invoker.planningTerminalWrite(sessionId, `printf "${text}\\n"\n`);
  }, { sessionId: terminalSessionId, text: sentinel });
  expect(result).toEqual({ ok: true });
  await expect(page.getByTestId('invoker-terminal-tmux-pane').getByText(sentinel, { exact: true })).toBeVisible({ timeout: 10000 });
}

async function readVisibleTerminalText(page: Page): Promise<string> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  return await pane.evaluate((element) => element.querySelector('.xterm-rows')?.textContent ?? '');
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

async function getPlanningTerminalDescriptor(page: Page, terminalSessionId: string): Promise<PlanningTerminalDescriptor> {
  const descriptor = await page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId) ?? null;
  }, terminalSessionId);
  if (!descriptor) throw new Error(`Planning terminal session "${terminalSessionId}" was not found`);
  return descriptor as PlanningTerminalDescriptor;
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
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

async function captureBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  terminalSessionId: string,
  sentinel: string,
): Promise<{ visibleText: string; backendSnapshot: string; screenshotPath: string }> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  await page.waitForTimeout(500);
  const visibleText = await readVisibleTerminalText(page);
  const descriptor = await getPlanningTerminalDescriptor(page, terminalSessionId);
  const backendSnapshot = descriptor.outputSnapshot ?? '';
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await page.getByTestId('invoker-terminal-tmux-pane').screenshot({ path: screenshotPath });
  const evidence = {
    label,
    terminalSessionId,
    sentinel,
    terminalStatus: descriptor.status,
    visibleText,
    normalizedVisibleText: normalizeTerminalText(visibleText),
    backendSnapshotContainsSentinel: backendSnapshot.includes(sentinel),
    backendSnapshotTail: backendSnapshot.slice(-500),
    screenshotPath,
  };
  await testInfo.attach(`${label}-terminal-evidence.json`, {
    body: JSON.stringify(evidence, null, 2),
    contentType: 'application/json',
  });
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify({
    label,
    terminalSessionId,
    sentinel,
    terminalStatus: descriptor.status,
    visibleTextLength: visibleText.length,
    normalizedVisibleText: evidence.normalizedVisibleText,
    backendSnapshotContainsSentinel: evidence.backendSnapshotContainsSentinel,
    backendSnapshotTail: evidence.backendSnapshotTail,
    screenshotPath,
  })}`);
  return { visibleText, backendSnapshot, screenshotPath };
}

async function assertCurrentBlankRepro(
  page: Page,
  testInfo: TestInfo,
  label: string,
  terminalSessionId: string,
  sentinel: string,
): Promise<void> {
  const evidence = await captureBlankEvidence(page, testInfo, label, terminalSessionId, sentinel);
  const failureContext = JSON.stringify({
    label,
    terminalSessionId,
    visibleTextLength: evidence.visibleText.length,
    normalizedVisibleText: normalizeTerminalText(evidence.visibleText),
    backendSnapshotTail: evidence.backendSnapshot.slice(-500),
    screenshotPath: evidence.screenshotPath,
  }, null, 2);
  expect(evidence.backendSnapshot, failureContext).toContain(sentinel);
  expect(evidence.visibleText, failureContext).not.toContain(sentinel);
  expect(normalizeTerminalText(evidence.visibleText), failureContext).toBe('');
}

async function bootstrapPlanningApp(page: Page, planYaml: string): Promise<void> {
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
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records the blank pane after switching planning tmux sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapPlanningApp(page, planYaml);

      const alphaTitle = 'Draft a YAML plan for alpha tmux blank repro';
      const betaTitle = 'Draft a YAML plan for beta tmux blank repro';
      const alphaSentinel = 'PLANNING_TMUX_ALPHA_SENTINEL_1729';
      const betaSentinel = 'PLANNING_TMUX_BETA_SENTINEL_2718';
      const alphaPlanningSessionId = await createDraftPlanningSession(page, alphaTitle);
      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      const betaPlanningSessionId = await createDraftPlanningSession(page, betaTitle);

      await selectPlanningSession(page, alphaTitle);
      const alphaTerminalSessionId = await openTmuxForPlanningSession(page, alphaPlanningSessionId);
      await writeSentinel(page, alphaTerminalSessionId, alphaSentinel);

      await selectPlanningSession(page, betaTitle);
      const betaTerminalSessionId = await openTmuxForPlanningSession(page, betaPlanningSessionId);
      await writeSentinel(page, betaTerminalSessionId, betaSentinel);

      await selectPlanningSession(page, alphaTitle);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaTerminalSessionId, { timeout: 10000 });
      await assertCurrentBlankRepro(
        page,
        testInfo,
        'planning-tmux-blank-after-session-switch-back',
        alphaTerminalSessionId,
        alphaSentinel,
      );
    } finally {
      if (page) await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app, userDataDir).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the blank pane after leaving planning terminal and returning with tmux still running', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await bootstrapPlanningApp(page, planYaml);

      const planningTitle = 'Draft a YAML plan for navigate tmux blank repro';
      const sentinel = 'PLANNING_TMUX_NAV_SENTINEL_3141';
      const planningSessionId = await createDraftPlanningSession(page, planningTitle);
      const terminalSessionId = await openTmuxForPlanningSession(page, planningSessionId);
      await writeSentinel(page, terminalSessionId, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => {
        const descriptor = await getPlanningTerminalDescriptor(page!, terminalSessionId);
        return {
          status: descriptor.status,
          containsSentinel: (descriptor.outputSnapshot ?? '').includes(sentinel),
        };
      }, { timeout: 10000 }).toEqual({ status: 'running', containsSentinel: true });

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId, { timeout: 10000 });
      await assertCurrentBlankRepro(
        page,
        testInfo,
        'planning-tmux-blank-after-navigation-return',
        terminalSessionId,
        sentinel,
      );
    } finally {
      if (page) await closePlanningTerminalSessions(page).catch(() => undefined);
      if (app) await closeApp(app, userDataDir).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

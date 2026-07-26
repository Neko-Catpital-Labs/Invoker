import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const EVIDENCE_DIR = path.join(process.cwd(), 'test-results', 'planning-terminal-tmux-blank-repro');

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

async function waitForPlanningReply(page: Page, prompt: string): Promise<void> {
  const transcript = page.getByTestId('invoker-terminal-transcript');
  await expect(transcript).toContainText(prompt, { timeout: 10000 });
  await expect(transcript).toContainText('I drafted the tmux blank repro plan.', { timeout: 10000 });
  await expect(page.getByTestId('planning-session-list')).toContainText(prompt, { timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
}

async function bootstrapPlanningApp(prefix: string): Promise<{
  app: ElectronApplication;
  page: Page;
  testDir: string;
}> {
  const testDir = mkdtempSync(path.join(tmpdir(), prefix));
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

async function openTmuxMode(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane mounted without data-session-id');
  await expect.poll(async () => {
    const list = await page.evaluate(() => window.invoker.planningTerminalList());
    return list.find((session) => session.sessionId === sessionId)?.status;
  }, { timeout: 10000 }).toBe('running');
  return sessionId;
}

async function currentTmuxSessionId(page: Page): Promise<string> {
  const sessionId = await page.getByTestId('invoker-terminal-tmux-pane').getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane is missing data-session-id');
  return sessionId;
}

async function terminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').locator('.xterm-rows').evaluate((element) => element.textContent ?? '');
}

function normalizeTerminalText(text: string): string {
  return text.replace(/\u00a0/g, ' ').trim();
}

async function waitForSentinel(page: Page, sentinel: string): Promise<void> {
  await expect.poll(async () => normalizeTerminalText(await terminalText(page)), { timeout: 10000 }).toContain(sentinel);
}

async function writeSentinel(page: Page, sentinel: string): Promise<string> {
  const sessionId = await currentTmuxSessionId(page);
  const command = `printf '\\033[2J\\033[H%s\\n' '${sentinel}'`;
  await page.evaluate(async ({ id, data }) => {
    const result = await window.invoker.planningTerminalWrite(id, data);
    if (!result.ok) throw new Error(result.reason ?? 'planningTerminalWrite failed');
  }, { id: sessionId, data: `${command}\n` });
  await waitForSentinel(page, sentinel);
  await expect.poll(async () => {
    const list = await page.evaluate(() => window.invoker.planningTerminalList());
    return list.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? '';
  }, { timeout: 10000 }).toContain(sentinel);
  return sessionId;
}

async function selectPlanningSession(page: Page, text: string): Promise<void> {
  await page.getByTestId('planning-session-list').getByRole('button').filter({ hasText: text }).click();
  await expect(page.getByText(text).first()).toBeVisible({ timeout: 10000 });
}

async function recordTerminalEvidence(page: Page, name: string): Promise<string> {
  mkdirSync(EVIDENCE_DIR, { recursive: true });
  const rawText = await terminalText(page);
  const normalizedText = normalizeTerminalText(rawText);
  const terminalList = await page.evaluate(() => window.invoker.planningTerminalList());
  writeFileSync(
    path.join(EVIDENCE_DIR, `${name}.txt`),
    [
      `normalizedText=${JSON.stringify(normalizedText)}`,
      `rawText=${JSON.stringify(rawText)}`,
      `planningTerminalList=${JSON.stringify(terminalList, null, 2)}`,
      '',
    ].join('\n'),
    'utf8',
  );
  await page.getByTestId('invoker-terminal-tmux-pane').screenshot({
    path: path.join(EVIDENCE_DIR, `${name}.png`),
  });
  return normalizedText;
}

async function expectBuggyBlankPane(page: Page, name: string, hiddenSentinel: string): Promise<void> {
  const text = await recordTerminalEvidence(page, name);
  expect(text, `${name} should record today's buggy blank planning tmux pane`).toBe('');
  expect(text).not.toContain(hiddenSentinel);
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('reproduces blank pane after switching planning tmux sessions and back', async () => {
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let testDir: string | undefined;
    try {
      ({ app, page, testDir } = await bootstrapPlanningApp('invoker-e2e-planning-tmux-session-blank-'));

      const alphaPrompt = 'Draft alpha planning tmux blank repro plan';
      const betaPrompt = 'Draft beta planning tmux blank repro plan';
      const alphaSentinel = 'PLANNING_TMUX_BLANK_REPRO_ALPHA_SENTINEL';
      const betaSentinel = 'PLANNING_TMUX_BLANK_REPRO_BETA_SENTINEL';

      await submitPlanningText(page, alphaPrompt);
      await waitForPlanningReply(page, alphaPrompt);
      await openTmuxMode(page);
      const alphaSessionId = await writeSentinel(page, alphaSentinel);

      await page.getByRole('button', { name: 'New chat' }).click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await submitPlanningText(page, betaPrompt);
      await waitForPlanningReply(page, betaPrompt);
      await openTmuxMode(page);
      const betaSessionId = await writeSentinel(page, betaSentinel);
      expect(betaSessionId).not.toBe(alphaSessionId);

      await selectPlanningSession(page, alphaPrompt);
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaSessionId);
      await expectBuggyBlankPane(page, 'after-session-switch-back', alphaSentinel);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      if (testDir) rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('reproduces blank pane after navigating away from planning terminal and back while tmux stays active', async () => {
    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    let testDir: string | undefined;
    try {
      ({ app, page, testDir } = await bootstrapPlanningApp('invoker-e2e-planning-tmux-nav-blank-'));

      const prompt = 'Draft navigation planning tmux blank repro plan';
      const sentinel = 'PLANNING_TMUX_BLANK_REPRO_NAV_SENTINEL';

      await submitPlanningText(page, prompt);
      await waitForPlanningReply(page, prompt);
      const terminalSessionId = await openTmuxMode(page);
      await writeSentinel(page, sentinel);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await expect.poll(async () => {
        const list = await page!.evaluate(() => window.invoker.planningTerminalList());
        return list.find((session) => session.sessionId === terminalSessionId)?.status;
      }, { timeout: 10000 }).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      await expectBuggyBlankPane(page, 'after-navigation-back', sentinel);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      if (testDir) rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { stringify as yamlStringify } from 'yaml';
import type { InvokerAPI } from '@invoker/contracts';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

declare global {
  interface Window {
    invoker: InvokerAPI;
  }
}

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const SWITCH_SCREENSHOT = 'visual-proof-planning-terminal-tmux-blank-after-session-switch.png';
const NAVIGATE_SCREENSHOT = 'visual-proof-planning-terminal-tmux-blank-after-navigation.png';
const ALPHA_SENTINEL = 'PLANNING_TMUX_ALPHA_SENTINEL';
const BETA_SENTINEL = 'PLANNING_TMUX_BETA_SENTINEL';

const PLANNING_TMUX_REPRO_PLAN = {
  name: 'Planning Terminal Tmux Blank Repro',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'tmux-blank-repro',
      description: 'Reproduce planning terminal tmux blanking',
      command: 'echo tmux-blank-repro',
      dependencies: [],
    },
  ],
};

function hasTmux(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
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

async function submitPlanningText(page: Page, text: string): Promise<void> {
  await page.getByTestId('invoker-terminal-input').fill(text);
  await page.getByTestId('invoker-terminal-input').press('Enter');
}

async function bootstrapDraftReadyPlanningSession(page: Page, planYaml: string): Promise<string> {
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
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });

  const savedSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id;
  });
  expect(savedSessionId).toBeTruthy();
  return savedSessionId;
}

async function openPlanningTmux(page: Page, planningSessionId: string): Promise<string> {
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
    };
  }, planningSessionId)).toEqual({
    mode: 'tmux',
    terminalSessionId,
  });

  return terminalSessionId ?? '';
}

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ terminalSessionId, input }) => {
    return window.invoker.planningTerminalWrite(terminalSessionId, input);
  }, { terminalSessionId: sessionId, input: data });
  expect(result).toEqual({ ok: true });
}

async function visibleTmuxText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').locator('.xterm-rows').evaluate((element) => element.textContent ?? '');
}

async function planningTerminalSnapshot(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? '';
  }, terminalSessionId);
}

async function waitForVisibleTerminalText(page: Page, text: string): Promise<void> {
  await expect.poll(() => visibleTmuxText(page), { timeout: 10000 }).toContain(text);
}

async function waitForSnapshotText(page: Page, terminalSessionId: string, text: string): Promise<void> {
  await expect.poll(() => planningTerminalSnapshot(page, terminalSessionId), { timeout: 10000 }).toContain(text);
}

async function seedTmuxSessions(page: Page, terminalSessionId: string, tmuxLabel: string, alphaSentinel: string, betaSentinel: string): Promise<void> {
  const setupCommand = [
    `tmux -L ${tmuxLabel} kill-server >/dev/null 2>&1 || true`,
    `tmux -L ${tmuxLabel} new-session -d -s alpha 'printf "\\033[2J\\033[H${alphaSentinel}\\n"; exec sh -c "while :; do sleep 1; done"'`,
    `tmux -L ${tmuxLabel} new-session -d -s beta 'printf "\\033[2J\\033[H${betaSentinel}\\n"; exec sh -c "while :; do sleep 1; done"'`,
    `tmux -L ${tmuxLabel} attach-session -t alpha`,
  ].join('; ');
  await writePlanningTerminal(page, terminalSessionId, `${setupCommand}\r`);
  await waitForVisibleTerminalText(page, alphaSentinel);
  await waitForSnapshotText(page, terminalSessionId, alphaSentinel);
}

async function switchTmuxClient(page: Page, terminalSessionId: string, targetSession: 'alpha' | 'beta'): Promise<void> {
  await writePlanningTerminal(page, terminalSessionId, `\u0002:switch-client -t ${targetSession}\r`);
}

async function recordBlankEvidence(page: Page, terminalSessionId: string, label: string, screenshotName: string, sentinels: { alpha: string; beta: string }): Promise<{
  label: string;
  screenshotPath: string;
  visibleText: string;
  visibleTextLength: number;
  snapshotIncludesAlpha: boolean;
  snapshotIncludesBeta: boolean;
}> {
  const screenshotPath = path.join(process.cwd(), screenshotName);
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await pane.screenshot({ path: screenshotPath });
  const visibleText = await visibleTmuxText(page);
  const snapshot = await planningTerminalSnapshot(page, terminalSessionId);
  const evidence = {
    label,
    screenshotPath,
    visibleText,
    visibleTextLength: visibleText.trim().length,
    snapshotIncludesAlpha: snapshot.includes(sentinels.alpha),
    snapshotIncludesBeta: snapshot.includes(sentinels.beta),
  };
  console.log(`PLANNING_TERMINAL_TMUX_BLANK_REPRO=${JSON.stringify(evidence)}`);
  return evidence;
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(!hasTmux(), 'tmux binary is required to reproduce planning-terminal tmux blanking.');

  base('records current blank screen after tmux session switches and navigation', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_REPRO_PLAN);
    const tmuxLabel = `planning-tmux-blank-${process.pid}`;
    const alphaSentinel = ALPHA_SENTINEL;
    const betaSentinel = BETA_SENTINEL;
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      const planningSessionId = await bootstrapDraftReadyPlanningSession(page, planYaml);
      const terminalSessionId = await openPlanningTmux(page, planningSessionId);
      await seedTmuxSessions(page, terminalSessionId, tmuxLabel, alphaSentinel, betaSentinel);

      await switchTmuxClient(page, terminalSessionId, 'beta');
      await waitForSnapshotText(page, terminalSessionId, betaSentinel);
      await switchTmuxClient(page, terminalSessionId, 'alpha');
      await waitForSnapshotText(page, terminalSessionId, alphaSentinel);

      const afterSessionSwitch = await recordBlankEvidence(
        page,
        terminalSessionId,
        'after-session-switch-back',
        SWITCH_SCREENSHOT,
        { alpha: alphaSentinel, beta: betaSentinel },
      );
      expect(afterSessionSwitch.snapshotIncludesAlpha).toBe(true);
      expect(afterSessionSwitch.snapshotIncludesBeta).toBe(true);
      expect(afterSessionSwitch.visibleText).not.toContain(alphaSentinel);
      expect(afterSessionSwitch.visibleText.trim()).toBe('');

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await waitForSnapshotText(page, terminalSessionId, alphaSentinel);

      const afterNavigation = await recordBlankEvidence(
        page,
        terminalSessionId,
        'after-navigation-away-and-back',
        NAVIGATE_SCREENSHOT,
        { alpha: alphaSentinel, beta: betaSentinel },
      );
      expect(afterNavigation.snapshotIncludesAlpha).toBe(true);
      expect(afterNavigation.snapshotIncludesBeta).toBe(true);
      expect(afterNavigation.visibleText).not.toContain(alphaSentinel);
      expect(afterNavigation.visibleText.trim()).toBe('');
    } finally {
      if (page) {
        await page.evaluate(async () => {
          const sessions = await window.invoker.planningTerminalList();
          for (const session of sessions) {
            await window.invoker.planningTerminalWrite(session.sessionId, `\u0002:kill-server\r`);
          }
        }).catch(() => undefined);
      }
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

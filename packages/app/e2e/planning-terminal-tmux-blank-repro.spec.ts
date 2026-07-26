import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { execFileSync } from 'node:child_process';
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
      id: 'update-readme',
      description: 'Update README',
      command: 'echo readme',
      dependencies: [],
    },
  ],
};

const ALPHA_TITLE = 'Alpha tmux blank repro';
const BETA_TITLE = 'Beta tmux blank repro';
const ALPHA_SENTINEL = 'TMUX_BLANK_REPRO_ALPHA_SENTINEL';
const BETA_SENTINEL = 'TMUX_BLANK_REPRO_BETA_SENTINEL';

function launchArgs(): string[] {
  return [
    ...(process.platform === 'linux'
      ? [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--disable-gpu-compositing',
          '--disable-gpu-sandbox',
          '--disable-software-rasterizer',
        ]
      : []),
    MAIN_JS,
  ];
}

function tmuxAvailable(): boolean {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function tmuxSessionName(testDir: string, suffix: string): string {
  const unique = path.basename(testDir).replace(/[^A-Za-z0-9]/g, '').slice(-12);
  return `invoker_e2e_${unique}_${suffix}`;
}

function killTmuxSessions(sessionNames: string[]): void {
  for (const sessionName of sessionNames) {
    try {
      execFileSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
    } catch {
      // The test owns these unique session names; missing sessions are fine.
    }
  }
}

function tmuxClientSessions(): string[] {
  try {
    return execFileSync('tmux', ['list-clients', '-F', '#{client_session}'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

async function waitForTmuxClientSession(sessionName: string): Promise<void> {
  await expect.poll(() => tmuxClientSessions().includes(sessionName), { timeout: 10000 }).toBe(true);
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
  await expect(page.getByTestId('planning-session-rail')).toBeVisible({ timeout: 10000 });
}

async function bootstrapPlanningPlanSessions(page: Page, planYaml: string): Promise<void> {
  await page.evaluate(async ({ yaml }) => {
    const seed = async (message: string, reply: string): Promise<void> => {
      await window.invoker.setTestPlanningChatResponse({
        planYaml: yaml,
        planName: 'Planning Terminal Tmux Blank Repro',
        reply,
      });
      const result = await window.invoker.planningChatSend({ message });
      if (!result.ok) throw new Error(result.error);
    };

    await seed('Alpha tmux blank repro', 'Alpha draft is ready for the tmux blank repro.');
    await seed('Beta tmux blank repro', 'Beta draft is ready for the tmux blank repro.');
    await window.invoker.setTestPlanningChatResponse(null);
  }, { yaml: planYaml });

  await page.reload();
  await waitForInvoker(page);
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('planning-session-list')
    .getByRole('button', { name: new RegExp(title) })
    .click();
}

async function openPlanningTmux(page: Page): Promise<string> {
  const tmuxTab = page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' });
  await tmuxTab.click();
  await expect(tmuxTab).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane did not expose a terminal session id.');
  return sessionId;
}

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(
    ({ id, input }) => window.invoker.planningTerminalWrite(id, input),
    { id: sessionId, input: data },
  );
  expect(result).toEqual({ ok: true });
}

async function readTerminalText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((pane) => {
    const rows = Array.from(pane.querySelectorAll('.xterm-rows > div'));
    if (rows.length > 0) {
      return rows.map((row) => row.textContent ?? '').join('\n');
    }
    return pane.textContent ?? '';
  });
}

function normalizeTerminalText(text: string): string {
  return text
    .replace(/\u00a0/g, ' ')
    .replace(/\u200b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function waitForTerminalText(page: Page, expected: string): Promise<void> {
  await expect.poll(() => readTerminalText(page), { timeout: 10000 }).toContain(expected);
}

async function waitForBackendSnapshot(page: Page, sessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => page.evaluate(async ({ id, text }) => {
    const sessions = await window.invoker.planningTerminalList();
    const session = sessions.find((candidate) => candidate.sessionId === id);
    return {
      found: Boolean(session),
      status: session?.status ?? null,
      hasSentinel: Boolean(session?.outputSnapshot?.includes(text)),
    };
  }, { id: sessionId, text: sentinel }), { timeout: 10000 }).toEqual({
    found: true,
    status: 'running',
    hasSentinel: true,
  });
}

async function seedTmuxPane(page: Page, sessionId: string, tmuxSession: string, sentinel: string): Promise<void> {
  const commands = [
    `tmux kill-session -t ${tmuxSession} 2>/dev/null || true`,
    `tmux new-session -d -s ${tmuxSession} 'printf "${sentinel}\\n"; exec bash --noprofile --norc'`,
    `tmux attach-session -t ${tmuxSession}`,
  ].join('\r') + '\r';
  await writePlanningTerminal(page, sessionId, commands);
  await waitForTerminalText(page, sentinel);
  await waitForBackendSnapshot(page, sessionId, sentinel);
}

async function seedSwitchableTmuxPanes(
  page: Page,
  sessionId: string,
  alphaTmux: string,
  betaTmux: string,
): Promise<void> {
  const commands = [
    `tmux kill-session -t ${alphaTmux} 2>/dev/null || true`,
    `tmux kill-session -t ${betaTmux} 2>/dev/null || true`,
    `tmux new-session -d -s ${alphaTmux} 'printf "${ALPHA_SENTINEL}\\n"; exec bash --noprofile --norc'`,
    `tmux new-session -d -s ${betaTmux} 'printf "${BETA_SENTINEL}\\n"; exec bash --noprofile --norc'`,
    `tmux attach-session -t ${alphaTmux}`,
  ].join('\r') + '\r';
  await writePlanningTerminal(page, sessionId, commands);
  await waitForTmuxClientSession(alphaTmux);
  await waitForTerminalText(page, ALPHA_SENTINEL);
  await waitForBackendSnapshot(page, sessionId, ALPHA_SENTINEL);
}

async function captureTerminalEvidence(page: Page, testInfo: TestInfo, label: string): Promise<{ text: string; normalizedText: string }> {
  const text = await readTerminalText(page);
  const normalizedText = normalizeTerminalText(text);
  const textPath = testInfo.outputPath(`${label}.txt`);
  const screenshotPath = testInfo.outputPath(`${label}.png`);
  writeFileSync(
    textPath,
    [
      `rawLength=${text.length}`,
      `normalizedLength=${normalizedText.length}`,
      '--- normalized ---',
      normalizedText || '[blank]',
      '--- raw ---',
      text || '[blank]',
      '',
    ].join('\n'),
    'utf8',
  );
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${label}-terminal-text`, { path: textPath, contentType: 'text/plain' });
  await testInfo.attach(`${label}-screenshot`, { path: screenshotPath, contentType: 'image/png' });
  return { text, normalizedText };
}

base.describe('Planning terminal tmux blank repro', () => {
  base.skip(!tmuxAvailable(), 'tmux is required for the planning terminal blank-screen repro.');

  base('records the current blank screen after switching tmux sessions inside the planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-session-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    const alphaTmux = tmuxSessionName(testDir, 'alpha');
    const betaTmux = tmuxSessionName(testDir, 'beta');
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
      await bootstrapPlanningPlanSessions(page, planYaml);
      await openPlanningTerminal(page);

      await selectPlanningSession(page, ALPHA_TITLE);
      const alphaSessionId = await openPlanningTmux(page);
      await seedSwitchableTmuxPanes(page, alphaSessionId, alphaTmux, betaTmux);
      await captureTerminalEvidence(page, testInfo, 'alpha-before-tmux-switch');

      await writePlanningTerminal(page, alphaSessionId, `tmux switch-client -t ${betaTmux}\r`);
      await waitForTmuxClientSession(betaTmux);
      await waitForTerminalText(page, BETA_SENTINEL);
      await captureTerminalEvidence(page, testInfo, 'beta-after-tmux-switch');

      await writePlanningTerminal(page, alphaSessionId, `tmux switch-client -t ${alphaTmux}\r`);
      await waitForTmuxClientSession(alphaTmux);
      await waitForBackendSnapshot(page, alphaSessionId, ALPHA_SENTINEL);

      const evidence = await captureTerminalEvidence(page, testInfo, 'alpha-after-tmux-switch-back-current-bug');
      // Current repro assertion: tmux switched back and the backend still has ALPHA_SENTINEL, but xterm is blank.
      // Flip this to require ALPHA_SENTINEL once the root cause is fixed.
      expect(evidence.text).not.toContain(ALPHA_SENTINEL);
      expect(evidence.normalizedText).toBe('');
    } finally {
      killTmuxSessions([alphaTmux, betaTmux]);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records the current blank screen after leaving and returning to an active planning tmux view', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-nav-switch-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
    const alphaTmux = tmuxSessionName(testDir, 'nav');
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
      await bootstrapPlanningPlanSessions(page, planYaml);
      await openPlanningTerminal(page);

      await selectPlanningSession(page, ALPHA_TITLE);
      const alphaSessionId = await openPlanningTmux(page);
      await seedTmuxPane(page, alphaSessionId, alphaTmux, ALPHA_SENTINEL);
      await captureTerminalEvidence(page, testInfo, 'alpha-before-navigation-away');

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await waitForBackendSnapshot(page, alphaSessionId, ALPHA_SENTINEL);

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alphaSessionId);

      const evidence = await captureTerminalEvidence(page, testInfo, 'alpha-after-navigation-back-current-bug');
      // Current repro assertion: the live backend still has ALPHA_SENTINEL, but the remounted xterm is blank.
      // Flip this to require ALPHA_SENTINEL once the root cause is fixed.
      expect(evidence.text).not.toContain(ALPHA_SENTINEL);
      expect(evidence.normalizedText).toBe('');
    } finally {
      killTmuxSessions([alphaTmux]);
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
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
      description: 'Record planning terminal tmux blanking',
      command: 'echo tmux blank repro',
      dependencies: [],
    },
  ],
};

const ALPHA_SENTINEL = 'PLANNING_TMUX_ALPHA_SENTINEL';
const BETA_SENTINEL = 'PLANNING_TMUX_BETA_SENTINEL';
const BETA_AFTER_SWITCH_SENTINEL = 'PLANNING_TMUX_BETA_AFTER_SWITCH_SENTINEL';
const ALPHA_AFTER_BACK_SENTINEL = 'PLANNING_TMUX_ALPHA_AFTER_BACK_SENTINEL';
const NAV_WHILE_AWAY_SENTINEL = 'PLANNING_TMUX_NAV_WHILE_AWAY_SENTINEL';

const TMUX_VERSION = (() => {
  const result = spawnSync('tmux', ['-V'], { encoding: 'utf8' });
  return result.status === 0 ? `${result.stdout}${result.stderr}`.trim() : null;
})();

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

async function bootstrapPlanningTmux(page: Page): Promise<{ planningSessionId: string; terminalSessionId: string }> {
  const planYaml = yamlStringify(PLANNING_TMUX_BLANK_PLAN);
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
  await submitPlanningText(page, 'Draft a YAML plan for the planning terminal tmux blank repro');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const planningSessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id ?? null;
  });
  if (!planningSessionId) throw new Error('planning session was not saved');

  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('planning tmux pane did not expose a terminal session id');
  await expect.poll(async () => {
    const sessions = await page.evaluate(() => window.invoker.planningTerminalList());
    return sessions.find((session) => session.sessionId === terminalSessionId)?.status ?? null;
  }, { timeout: 10000 }).toBe('running');

  return { planningSessionId, terminalSessionId };
}

function tmuxSessionNames(testInfo: TestInfo): { alpha: string; beta: string } {
  const suffix = `w${testInfo.workerIndex}_r${testInfo.retry}_p${testInfo.repeatEachIndex}`;
  return {
    alpha: `invoker_e2e_blank_alpha_${suffix}`,
    beta: `invoker_e2e_blank_beta_${suffix}`,
  };
}

function tmuxBootstrapCommand(names: { alpha: string; beta: string }): string {
  return [
    `tmux kill-session -t ${names.alpha} >/dev/null 2>&1 || true`,
    `tmux kill-session -t ${names.beta} >/dev/null 2>&1 || true`,
    `tmux new-session -d -s ${names.alpha} "printf '\\033[2J\\033[H%s\\n' '${ALPHA_SENTINEL}'; exec sh"`,
    `tmux new-session -d -s ${names.beta} "printf '\\033[2J\\033[H%s\\n' '${BETA_SENTINEL}'; exec sh"`,
    `tmux attach-session -t ${names.alpha}`,
  ].join('\n') + '\n';
}

function killTmuxSessions(names: { alpha: string; beta: string }): void {
  for (const sessionName of [names.alpha, names.beta]) {
    spawnSync('tmux', ['kill-session', '-t', sessionName], { stdio: 'ignore' });
  }
}

async function writePlanningTerminal(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ id, input }) => (
    window.invoker.planningTerminalWrite(id, input)
  ), { id: sessionId, input: data });
  if (!result?.ok) throw new Error(`planning terminal write failed: ${result?.reason ?? 'unknown reason'}`);
}

async function planningTerminalSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === id)?.outputSnapshot ?? '';
  }, sessionId);
}

async function waitForBackendSnapshot(page: Page, sessionId: string, sentinel: string): Promise<void> {
  await expect.poll(async () => planningTerminalSnapshot(page, sessionId), { timeout: 10000 }).toContain(sentinel);
}

function occurrenceCount(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

async function waitForBackendSnapshotOccurrences(
  page: Page,
  sessionId: string,
  sentinel: string,
  expectedCount: number,
): Promise<void> {
  await expect.poll(async () => occurrenceCount(await planningTerminalSnapshot(page, sessionId), sentinel), { timeout: 10000 }).toBeGreaterThanOrEqual(expectedCount);
}

async function terminalPaneText(page: Page): Promise<string> {
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((element) => {
    const rows = element.querySelector('.xterm-rows') as HTMLElement | null;
    const target = rows ?? element;
    return (target.innerText || target.textContent || '').replace(/\u00a0/g, ' ');
  });
}

async function waitForVisiblePaneText(page: Page, sentinel: string): Promise<void> {
  await expect.poll(async () => terminalPaneText(page), { timeout: 10000 }).toContain(sentinel);
}

async function captureBlankEvidence(
  page: Page,
  sessionId: string,
  artifactName: string,
): Promise<{ visibleText: string; backendSnapshot: string; screenshotPath: string; evidencePath: string }> {
  const screenshotPath = path.join(process.cwd(), `${artifactName}.png`);
  const evidencePath = path.join(process.cwd(), `${artifactName}.json`);
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const visibleText = await terminalPaneText(page);
  const backendSnapshot = await planningTerminalSnapshot(page, sessionId);
  await pane.screenshot({ path: screenshotPath });
  writeFileSync(evidencePath, JSON.stringify({
    artifactName,
    tmuxVersion: TMUX_VERSION,
    terminalSessionId: sessionId,
    visibleText,
    backendSnapshot,
    screenshotPath,
  }, null, 2), 'utf8');
  return { visibleText, backendSnapshot, screenshotPath, evidencePath };
}

base.describe('Planning Terminal tmux blank repro', () => {
  base.skip(!TMUX_VERSION, 'tmux is required to reproduce planning terminal tmux blanking');

  base('records blanking after switching tmux sessions inside the planning terminal and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-switch-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const names = tmuxSessionNames(testInfo);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const { terminalSessionId } = await bootstrapPlanningTmux(page);

      await writePlanningTerminal(page, terminalSessionId, tmuxBootstrapCommand(names));
      await waitForBackendSnapshot(page, terminalSessionId, ALPHA_SENTINEL);
      await waitForVisiblePaneText(page, ALPHA_SENTINEL);

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${names.beta}\n`);
      await waitForBackendSnapshot(page, terminalSessionId, BETA_SENTINEL);
      await writePlanningTerminal(page, terminalSessionId, `printf '${BETA_AFTER_SWITCH_SENTINEL}\\n'\n`);
      await waitForBackendSnapshot(page, terminalSessionId, BETA_AFTER_SWITCH_SENTINEL);
      const betaEvidence = await captureBlankEvidence(
        page,
        terminalSessionId,
        'visual-proof-planning-terminal-tmux-switch-to-beta-blank',
      );
      expect(betaEvidence.backendSnapshot).toContain(BETA_AFTER_SWITCH_SENTINEL);
      expect(betaEvidence.visibleText, 'current repro records the beta tmux pane as visually blank').not.toContain(BETA_AFTER_SWITCH_SENTINEL);

      await writePlanningTerminal(page, terminalSessionId, `tmux switch-client -t ${names.alpha}\n`);
      await waitForBackendSnapshotOccurrences(page, terminalSessionId, ALPHA_SENTINEL, 2);
      await writePlanningTerminal(page, terminalSessionId, `printf '${ALPHA_AFTER_BACK_SENTINEL}\\n'\n`);
      await waitForBackendSnapshot(page, terminalSessionId, ALPHA_AFTER_BACK_SENTINEL);
      const alphaEvidence = await captureBlankEvidence(
        page,
        terminalSessionId,
        'visual-proof-planning-terminal-tmux-switch-back-alpha-blank',
      );
      expect(alphaEvidence.backendSnapshot).toContain(ALPHA_AFTER_BACK_SENTINEL);
      expect(alphaEvidence.visibleText, 'current repro records the switched-back tmux pane as visually blank').not.toContain(ALPHA_AFTER_BACK_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      killTmuxSessions(names);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records blanking after navigating away and back while planning tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-route-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const names = tmuxSessionNames(testInfo);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath });
      app = launched.app;
      const page = launched.page;
      const { planningSessionId, terminalSessionId } = await bootstrapPlanningTmux(page);

      await writePlanningTerminal(page, terminalSessionId, tmuxBootstrapCommand(names));
      await waitForBackendSnapshot(page, terminalSessionId, ALPHA_SENTINEL);
      await waitForVisiblePaneText(page, ALPHA_SENTINEL);

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveCount(0);
      await writePlanningTerminal(page, terminalSessionId, `printf '${NAV_WHILE_AWAY_SENTINEL}\\n'\n`);
      await waitForBackendSnapshot(page, terminalSessionId, NAV_WHILE_AWAY_SENTINEL);
      await expect.poll(async () => page.evaluate(async (id) => {
        const sessions = await window.invoker.planningTerminalList();
        return sessions.find((session) => session.sessionId === id)?.status ?? null;
      }, terminalSessionId), { timeout: 10000 }).toBe('running');

      await openPlanningTerminal(page);
      await expect(page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' })).toHaveAttribute('aria-selected', 'true', { timeout: 10000 });
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminalSessionId);
      await expect.poll(async () => page.evaluate(async (sessionId) => {
        const list = await window.invoker.planningChatList();
        const session = list.sessions.find((candidate) => candidate.id === sessionId);
        return {
          mode: session?.terminalMode,
          terminalSessionId: session?.terminalSessionId,
          terminalStatus: session?.terminalStatus,
        };
      }, planningSessionId)).toEqual({
        mode: 'tmux',
        terminalSessionId,
        terminalStatus: 'running',
      });

      const routeEvidence = await captureBlankEvidence(
        page,
        terminalSessionId,
        'visual-proof-planning-terminal-tmux-route-return-blank',
      );
      expect(routeEvidence.backendSnapshot).toContain(NAV_WHILE_AWAY_SENTINEL);
      expect(routeEvidence.visibleText, 'current repro records the remounted planning tmux pane as visually blank').not.toContain(NAV_WHILE_AWAY_SENTINEL);
      expect(routeEvidence.visibleText, 'current repro records the original tmux pane output as missing after remount').not.toContain(ALPHA_SENTINEL);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      killTmuxSessions(names);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

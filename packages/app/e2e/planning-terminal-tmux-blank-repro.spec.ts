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
      id: 'record-repro',
      description: 'Record tmux blank repro',
      command: 'echo repro',
      dependencies: [],
    },
  ],
};

interface TerminalPaneSample {
  innerText: string;
  textContent: string;
  canvasCount: number;
  brightPixels: number;
  canvasSizes: string[];
  sampleErrors: string[];
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

async function bootstrapDraftReadyPlanningSession(page: Page, planYaml: string): Promise<string> {
  await page.evaluate(async ({ yaml }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: 'Planning Terminal Tmux Blank Repro',
      reply: 'I drafted the tmux blank repro plan.',
    });
  }, { yaml: planYaml });

  await openPlanningTerminal(page);
  await submitPlanningText(page, 'Draft a YAML plan for the tmux blank repro');
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });

  const sessionId = await page.evaluate(async () => {
    const list = await window.invoker.planningChatList();
    return list.sessions[0]?.id;
  });
  if (!sessionId) throw new Error('planning chat session was not created');
  return sessionId;
}

async function openTmuxForActivePlanningSession(page: Page): Promise<{ planningSessionId: string; terminalSessionId: string }> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const terminalSessionId = await pane.getAttribute('data-session-id');
  if (!terminalSessionId) throw new Error('planning tmux pane has no terminal session id');

  const planningSessionId = await page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.terminalSessionId === sessionId)?.id ?? null;
  }, terminalSessionId);
  if (!planningSessionId) throw new Error(`planning chat session for terminal ${terminalSessionId} was not found`);

  return { planningSessionId, terminalSessionId };
}

async function createNewTmuxPlanningSession(page: Page): Promise<{ planningSessionId: string; terminalSessionId: string }> {
  await page.getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  return openTmuxForActivePlanningSession(page);
}

async function writeSentinelToTmux(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  const result = await page.evaluate(
    async ({ sessionId, command }) => window.invoker.planningTerminalWrite(sessionId, command),
    {
      sessionId: terminalSessionId,
      command: `printf '${sentinel}\\n'\n`,
    },
  );
  expect(result).toMatchObject({ ok: true });
}

async function terminalOutputSnapshot(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.outputSnapshot ?? '';
  }, terminalSessionId);
}

async function planningChatTerminalSnapshot(page: Page, planningSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session) => session.id === sessionId)?.terminalOutputSnapshot ?? '';
  }, planningSessionId);
}

async function terminalStatus(page: Page, terminalSessionId: string): Promise<string | undefined> {
  return page.evaluate(async (sessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === sessionId)?.status;
  }, terminalSessionId);
}

async function waitForTerminalSnapshot(page: Page, terminalSessionId: string, sentinel: string): Promise<void> {
  await expect.poll(
    () => terminalOutputSnapshot(page, terminalSessionId),
    { timeout: 10000 },
  ).toContain(sentinel);
}

async function sampleVisibleTmuxPane(page: Page): Promise<TerminalPaneSample> {
  await expect(page.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
  return page.getByTestId('invoker-terminal-tmux-pane').evaluate((host) => {
    const element = host as HTMLElement;
    const rowText = Array.from(element.querySelectorAll('.xterm-rows > div'))
      .map((row) => (row as HTMLElement).innerText ?? row.textContent ?? '')
      .join('\n');
    const accessibleText = Array.from(element.querySelectorAll('.xterm-accessibility-tree *'))
      .map((node) => node.textContent ?? '')
      .join('\n');
    const canvases = Array.from(element.querySelectorAll('canvas'));
    let brightPixels = 0;
    const canvasSizes: string[] = [];
    const sampleErrors: string[] = [];

    for (const canvas of canvases) {
      canvasSizes.push(`${canvas.width}x${canvas.height}`);
      if (canvas.width === 0 || canvas.height === 0) continue;
      try {
        const context = canvas.getContext('2d', { willReadFrequently: true });
        if (!context) continue;
        const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
        for (let index = 0; index < data.length; index += 4) {
          const alpha = data[index + 3] ?? 0;
          const red = data[index] ?? 0;
          const green = data[index + 1] ?? 0;
          const blue = data[index + 2] ?? 0;
          if (alpha > 0 && red > 120 && green > 120 && blue > 120) {
            brightPixels += 1;
          }
        }
      } catch (err) {
        sampleErrors.push(err instanceof Error ? err.message : String(err));
      }
    }

    return {
      innerText: element.innerText ?? '',
      textContent: rowText || accessibleText,
      canvasCount: canvases.length,
      brightPixels,
      canvasSizes,
      sampleErrors,
    };
  });
}

function sampleContainsSentinel(sample: TerminalPaneSample, sentinel: string): boolean {
  return sample.innerText.includes(sentinel) || sample.textContent.includes(sentinel);
}

function hasVisibleTerminalOutput(sample: TerminalPaneSample, sentinel: string): boolean {
  return sampleContainsSentinel(sample, sentinel) || sample.brightPixels > 1000;
}

async function waitForVisibleSentinelOutput(page: Page, sentinel: string): Promise<TerminalPaneSample> {
  await expect.poll(async () => {
    const sample = await sampleVisibleTmuxPane(page);
    return hasVisibleTerminalOutput(sample, sentinel);
  }, { timeout: 10000 }).toBe(true);
  return sampleVisibleTmuxPane(page);
}

function expectCurrentlyBlankAfterSwitch(beforeSwitch: TerminalPaneSample, afterSwitch: TerminalPaneSample, sentinel: string): void {
  expect(afterSwitch.innerText).not.toContain(sentinel);
  expect(afterSwitch.textContent).not.toContain(sentinel);
  if (beforeSwitch.brightPixels > 1000) {
    expect(afterSwitch.brightPixels).toBeLessThan(Math.max(200, Math.floor(beforeSwitch.brightPixels * 0.2)));
  }
}

async function recordPostSwitchEvidence(
  page: Page,
  testInfo: TestInfo,
  name: string,
  evidence: Record<string, unknown>,
): Promise<void> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.getByTestId('invoker-terminal-tmux-pane').screenshot({ path: screenshotPath });
  await testInfo.attach(`${name}-screenshot`, { path: screenshotPath, contentType: 'image/png' });

  const evidencePath = testInfo.outputPath(`${name}.json`);
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  await testInfo.attach(`${name}-terminal-evidence`, { path: evidencePath, contentType: 'application/json' });
}

base.describe('Planning terminal tmux blank repro', () => {
  base('records current blank pane after switching tmux planning sessions and back', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-sessions-'));
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

      const alphaPlanningSessionId = await bootstrapDraftReadyPlanningSession(page, planYaml);
      const alpha = await openTmuxForActivePlanningSession(page);
      expect(alpha.planningSessionId).toBe(alphaPlanningSessionId);
      await writeSentinelToTmux(page, alpha.terminalSessionId, 'TMUX_BLANK_REPRO_ALPHA');
      await waitForTerminalSnapshot(page, alpha.terminalSessionId, 'TMUX_BLANK_REPRO_ALPHA');
      const alphaBeforeSwitch = await waitForVisibleSentinelOutput(page, 'TMUX_BLANK_REPRO_ALPHA');

      const beta = await createNewTmuxPlanningSession(page);
      await writeSentinelToTmux(page, beta.terminalSessionId, 'TMUX_BLANK_REPRO_BETA');
      await waitForTerminalSnapshot(page, beta.terminalSessionId, 'TMUX_BLANK_REPRO_BETA');
      const betaBeforeSwitch = await waitForVisibleSentinelOutput(page, 'TMUX_BLANK_REPRO_BETA');

      await page.getByTestId('planning-session-list').getByRole('button').nth(1).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', alpha.terminalSessionId, { timeout: 10000 });
      const alphaAfterSwitchBack = await sampleVisibleTmuxPane(page);
      // Repro assertion: the backing terminal has the sentinel, but the remounted pane is blank today.
      expect(await terminalOutputSnapshot(page, alpha.terminalSessionId)).toContain('TMUX_BLANK_REPRO_ALPHA');
      expect(await planningChatTerminalSnapshot(page, alpha.planningSessionId)).toContain('TMUX_BLANK_REPRO_ALPHA');
      expectCurrentlyBlankAfterSwitch(alphaBeforeSwitch, alphaAfterSwitchBack, 'TMUX_BLANK_REPRO_ALPHA');
      await recordPostSwitchEvidence(page, testInfo, 'planning-tmux-session-alpha-after-switch-back', {
        switchPath: 'planning-session-list',
        planningSessionId: alpha.planningSessionId,
        terminalSessionId: alpha.terminalSessionId,
        terminalStatus: await terminalStatus(page, alpha.terminalSessionId),
        sentinel: 'TMUX_BLANK_REPRO_ALPHA',
        backingSnapshot: await terminalOutputSnapshot(page, alpha.terminalSessionId),
        planningChatSnapshot: await planningChatTerminalSnapshot(page, alpha.planningSessionId),
        beforeSwitchPane: alphaBeforeSwitch,
        afterSwitchPane: alphaAfterSwitchBack,
      });

      await page.getByTestId('planning-session-list').getByRole('button').nth(0).click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', beta.terminalSessionId, { timeout: 10000 });
      const betaAfterSwitchBack = await sampleVisibleTmuxPane(page);
      expect(await terminalOutputSnapshot(page, beta.terminalSessionId)).toContain('TMUX_BLANK_REPRO_BETA');
      expect(await planningChatTerminalSnapshot(page, beta.planningSessionId)).toContain('TMUX_BLANK_REPRO_BETA');
      expectCurrentlyBlankAfterSwitch(betaBeforeSwitch, betaAfterSwitchBack, 'TMUX_BLANK_REPRO_BETA');
      await recordPostSwitchEvidence(page, testInfo, 'planning-tmux-session-beta-after-switch-back', {
        switchPath: 'planning-session-list',
        planningSessionId: beta.planningSessionId,
        terminalSessionId: beta.terminalSessionId,
        terminalStatus: await terminalStatus(page, beta.terminalSessionId),
        sentinel: 'TMUX_BLANK_REPRO_BETA',
        backingSnapshot: await terminalOutputSnapshot(page, beta.terminalSessionId),
        planningChatSnapshot: await planningChatTerminalSnapshot(page, beta.planningSessionId),
        beforeSwitchPane: betaBeforeSwitch,
        afterSwitchPane: betaAfterSwitchBack,
      });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  base('records current blank pane after navigating away and back while tmux remains active', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-nav-'));
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

      const planningSessionId = await bootstrapDraftReadyPlanningSession(page, planYaml);
      const terminal = await openTmuxForActivePlanningSession(page);
      expect(terminal.planningSessionId).toBe(planningSessionId);
      await writeSentinelToTmux(page, terminal.terminalSessionId, 'TMUX_BLANK_REPRO_NAV');
      await waitForTerminalSnapshot(page, terminal.terminalSessionId, 'TMUX_BLANK_REPRO_NAV');
      const beforeNavigation = await waitForVisibleSentinelOutput(page, 'TMUX_BLANK_REPRO_NAV');

      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      expect(await terminalStatus(page, terminal.terminalSessionId)).toBe('running');

      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-tmux-pane')).toHaveAttribute('data-session-id', terminal.terminalSessionId, { timeout: 10000 });
      const afterNavigation = await sampleVisibleTmuxPane(page);
      // Repro assertion: navigation remounts the stale cached terminal descriptor, leaving a blank pane.
      expect(await terminalOutputSnapshot(page, terminal.terminalSessionId)).toContain('TMUX_BLANK_REPRO_NAV');
      expect(await planningChatTerminalSnapshot(page, planningSessionId)).toContain('TMUX_BLANK_REPRO_NAV');
      expect(await terminalStatus(page, terminal.terminalSessionId)).toBe('running');
      expectCurrentlyBlankAfterSwitch(beforeNavigation, afterNavigation, 'TMUX_BLANK_REPRO_NAV');
      await recordPostSwitchEvidence(page, testInfo, 'planning-tmux-after-sidebar-away-back', {
        switchPath: 'sidebar-planning-to-home',
        planningSessionId,
        terminalSessionId: terminal.terminalSessionId,
        terminalStatus: await terminalStatus(page, terminal.terminalSessionId),
        sentinel: 'TMUX_BLANK_REPRO_NAV',
        backingSnapshot: await terminalOutputSnapshot(page, terminal.terminalSessionId),
        planningChatSnapshot: await planningChatTerminalSnapshot(page, planningSessionId),
        beforeNavigationPane: beforeNavigation,
        afterNavigationPane: afterNavigation,
      });
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

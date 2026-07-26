import { test as base, _electron as electron, expect, type ElectronApplication, type Locator, type Page, type TestInfo } from '@playwright/test';
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
      id: 'record-tmux-blank-repro',
      description: 'Record planning terminal tmux blank repro',
      command: 'echo tmux-blank-repro',
      dependencies: [],
    },
  ],
};

const ALPHA_PROMPT = 'Draft a YAML plan for tmux blank alpha';
const BETA_PROMPT = 'Draft a YAML plan for tmux blank beta';
const ALPHA_SENTINEL = 'PLANNING_TMUX_ALPHA_SENTINEL';
const BETA_SENTINEL = 'PLANNING_TMUX_BETA_SENTINEL';
const NAV_SENTINEL = 'PLANNING_TMUX_NAV_SENTINEL';

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

async function createDraftReadyPlanningSession(page: Page, prompt: string): Promise<string> {
  await submitPlanningText(page, prompt);
  await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText('Draft ready', { timeout: 10000 });
  const sessionId = await page.evaluate(async (title) => {
    const list = await window.invoker.planningChatList();
    return list.sessions.find((session: { id: string; title: string }) => session.title === title)?.id ?? null;
  }, prompt);
  expect(sessionId).toBeTruthy();
  return sessionId!;
}

async function selectPlanningSession(page: Page, title: string): Promise<void> {
  await page
    .getByTestId('planning-session-list')
    .getByRole('button', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) })
    .click();
}

async function createNewPlanningChat(page: Page): Promise<void> {
  await page.getByTestId('planning-session-rail').getByRole('button', { name: 'New chat' }).click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('invoker-terminal-input')).toHaveValue('');
}

async function openTmuxPane(page: Page): Promise<{ pane: Locator; sessionId: string }> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await pane.locator('.xterm-rows').waitFor({ state: 'attached', timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  if (!sessionId) throw new Error('Planning tmux pane mounted without data-session-id');
  await expect.poll(async () => page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session: { sessionId: string }) => session.sessionId === id)?.status ?? null;
  }, sessionId), { timeout: 10000 }).toBe('running');
  return { pane, sessionId };
}

async function activeTmuxPaneForSession(page: Page, sessionId: string): Promise<Locator> {
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  await expect(pane).toHaveAttribute('data-session-id', sessionId, { timeout: 10000 });
  await pane.locator('.xterm-rows').waitFor({ state: 'attached', timeout: 10000 });
  return pane;
}

async function terminalRowsText(pane: Locator): Promise<string> {
  return pane.evaluate((element) => {
    const rows = element.querySelector('.xterm-rows');
    const raw = rows instanceof HTMLElement ? rows.innerText : rows?.textContent ?? '';
    return raw.replace(/\u00a0/g, ' ');
  });
}

async function planningTerminalSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session: { sessionId: string }) => session.sessionId === id)?.outputSnapshot ?? '';
  }, sessionId);
}

async function planningTerminalStatus(page: Page, sessionId: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session: { sessionId: string }) => session.sessionId === id)?.status ?? null;
  }, sessionId);
}

async function writeSentinel(page: Page, pane: Locator, sessionId: string, sentinel: string): Promise<void> {
  await pane.click();
  await page.keyboard.type(`printf "${sentinel}\\n"`);
  await page.keyboard.press('Enter');
  await expect(pane.locator('.xterm-rows')).toContainText(sentinel, { timeout: 10000 });
  await expect.poll(async () => planningTerminalSnapshot(page, sessionId), { timeout: 10000 }).toContain(sentinel);
}

async function attachBlankEvidence(
  page: Page,
  testInfo: TestInfo,
  label: string,
  pane: Locator,
  sessionId: string,
  sentinel: string,
): Promise<void> {
  await page.waitForTimeout(300);
  const terminalText = await terminalRowsText(pane);
  const backendSnapshot = await planningTerminalSnapshot(page, sessionId);
  const backendStatus = await planningTerminalStatus(page, sessionId);
  const screenshotPath = path.join(process.cwd(), `visual-proof-planning-terminal-tmux-blank-${label}.png`);
  await pane.screenshot({ path: screenshotPath });

  const evidence = {
    label,
    sessionId,
    sentinel,
    backendStatus,
    terminalText,
    terminalTextLength: terminalText.length,
    backendSnapshotLength: backendSnapshot.length,
    terminalTextContainsSentinel: terminalText.includes(sentinel),
    backendSnapshotContainsSentinel: backendSnapshot.includes(sentinel),
  };
  await testInfo.attach(`${label}-terminal-text`, {
    body: terminalText || '<empty>',
    contentType: 'text/plain',
  });
  await testInfo.attach(`${label}-backend-snapshot`, {
    body: backendSnapshot || '<empty>',
    contentType: 'text/plain',
  });
  await testInfo.attach(`${label}-terminal-screenshot`, {
    path: screenshotPath,
    contentType: 'image/png',
  });
  console.log(`PLANNING_TMUX_BLANK_REPRO_${label.toUpperCase()}=${JSON.stringify(evidence)}`);

  expect(backendStatus, JSON.stringify(evidence)).toBe('running');
  expect(backendSnapshot, JSON.stringify(evidence)).toContain(sentinel);
  // Repro slice: assert the currently observed defect. After the root-cause fix,
  // this should flip to require the sentinel in the remounted xterm rows.
  expect(terminalText, JSON.stringify(evidence)).not.toContain(sentinel);
  expect(terminalText.trim(), JSON.stringify(evidence)).toBe('');
}

base.describe('Planning Terminal tmux blank repro', () => {
  base('records blank xterm rows after tmux session and view switches', async ({}, testInfo) => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-planning-tmux-blank-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const planYaml = yamlStringify(PLANNING_TMUX_BLANK_REPRO_PLAN);
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
      const alphaPlanningSessionId = await createDraftReadyPlanningSession(page, ALPHA_PROMPT);
      let alpha = await openTmuxPane(page);
      expect(alpha.sessionId).toBeTruthy();
      await writeSentinel(page, alpha.pane, alpha.sessionId, ALPHA_SENTINEL);

      await createNewPlanningChat(page);
      const betaPlanningSessionId = await createDraftReadyPlanningSession(page, BETA_PROMPT);
      const beta = await openTmuxPane(page);
      expect(beta.sessionId).toBeTruthy();
      await writeSentinel(page, beta.pane, beta.sessionId, BETA_SENTINEL);

      await selectPlanningSession(page, ALPHA_PROMPT);
      alpha.pane = await activeTmuxPaneForSession(page, alpha.sessionId);
      await attachBlankEvidence(
        page,
        testInfo,
        'session-switch',
        alpha.pane,
        alpha.sessionId,
        ALPHA_SENTINEL,
      );

      await writeSentinel(page, alpha.pane, alpha.sessionId, NAV_SENTINEL);
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
      await page.getByTestId('sidebar-home').click();
      alpha.pane = await activeTmuxPaneForSession(page, alpha.sessionId);
      await attachBlankEvidence(
        page,
        testInfo,
        'view-return',
        alpha.pane,
        alpha.sessionId,
        NAV_SENTINEL,
      );

      await expect.poll(async () => page!.evaluate(async (ids) => {
        const list = await window.invoker.planningChatList();
        return ids.every((id) => list.sessions.some((session: { id: string }) => session.id === id));
      }, [alphaPlanningSessionId, betaPlanningSessionId])).toBe(true);
    } finally {
      if (app) await closeApp(app).catch(() => undefined);
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

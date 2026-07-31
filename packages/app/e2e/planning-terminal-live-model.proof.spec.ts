import { expect, test as base, _electron as electron, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');
const E2E_BARE_REPO = process.env.INVOKER_E2E_BARE_REPO ?? '/tmp/invoker-e2e-repo.git';
const E2E_REPO_URL = pathToFileURL(E2E_BARE_REPO).href;
const LIVE_PROOF_ENABLED = process.env.INVOKER_E2E_LIVE_PLANNER === '1';
const LIVE_PLANNER_MODEL = process.env.INVOKER_E2E_LIVE_PLANNER_MODEL?.trim();
const LIVE_PLANNER_TIMEOUT_SECONDS = readPositiveIntEnv('INVOKER_E2E_LIVE_PLANNER_TIMEOUT_SECONDS', 300);
const LIVE_PROOF_PLAN_NAME = 'Live planner black to pink proof';
const LIVE_PROOF_SCREENSHOT = process.env.INVOKER_E2E_LIVE_PLANNER_PROOF_SCREENSHOT?.trim();

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireCodexOnPath(): string {
  const result = spawnSync('bash', ['-lc', 'command -v codex'], { encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error('INVOKER_E2E_LIVE_PLANNER=1 requires a real `codex` CLI on PATH.');
  }
  return result.stdout.trim();
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

async function launchLivePlannerApp(paths: {
  dbDir: string;
  userDataDir: string;
  ipcSocketPath: string;
  configPath: string;
}): Promise<{ app: ElectronApplication; page: Page }> {
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
      INVOKER_EMBEDDED_TERMINAL_BACKEND:
        process.env.INVOKER_E2E_EMBEDDED_TERMINAL_BACKEND ?? 'pty',
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

async function attachPlanningState(page: Page | undefined, testInfo: TestInfo, codexPath: string): Promise<void> {
  if (!page) return;
  const evidence = await page.evaluate(async () => {
    const planning = await window.invoker.planningChatList().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    const workflows = await window.invoker.listWorkflows().catch((error: unknown) => ({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }));
    return { planning, workflows };
  }).catch((error: unknown) => ({
    planning: { ok: false, error: error instanceof Error ? error.message : String(error) },
    workflows: { ok: false, error: error instanceof Error ? error.message : String(error) },
  }));
  await testInfo.attach('live-planning-state.json', {
    body: Buffer.from(JSON.stringify({ codexPath, ...evidence }, null, 2)),
    contentType: 'application/json',
  });
}

base.describe('Planning terminal live model proof', () => {
  base.skip(!LIVE_PROOF_ENABLED, 'Set INVOKER_E2E_LIVE_PLANNER=1 to run the live model planning proof.');

  base('continues a real Codex planning session, then drafts and submits a workflow', async ({}, testInfo) => {
    base.setTimeout((LIVE_PLANNER_TIMEOUT_SECONDS * 2 + 120) * 1000);

    const codexPath = requireCodexOnPath();
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-live-planner-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const userDataDir = path.join(testDir, 'electron-user-data');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    writeFileSync(configPath, JSON.stringify({
      autoFixRetries: 0,
      defaultRepoUrl: E2E_REPO_URL,
      defaultPlanningTerminalConfirmationMode: 'require',
      defaultSlackHarnessPreset: 'live-codex',
      disableAutoRunOnStartup: true,
      planningTimeoutSeconds: LIVE_PLANNER_TIMEOUT_SECONDS,
      slackHarnessPresets: {
        'live-codex': {
          tool: 'codex',
          ...(LIVE_PLANNER_MODEL ? { model: LIVE_PLANNER_MODEL } : {}),
        },
      },
    }), 'utf8');

    let app: ElectronApplication | undefined;
    let page: Page | undefined;
    try {
      ({ app, page } = await launchLivePlannerApp({ dbDir: testDir, userDataDir, ipcSocketPath, configPath }));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      const activityLogWatermark = await page.evaluate(async () => {
        const logs = await window.invoker.getActivityLogs(0, 2000);
        return logs.at(-1)?.id ?? 0;
      });

      await openPlanningTerminal(page);
      await submitPlanningText(page, [
        'This is a live e2e proof for the planning terminal.',
        'Do not draft YAML yet.',
        'Reply with a short acknowledgement that includes READY_TO_DRAFT_BLACK_TO_PINK.',
      ].join('\n'));

      await expect.poll(async () => {
        const list = await page!.evaluate(async () => window.invoker.planningChatList());
        const session = list.sessions[0];
        return session?.messages.filter((message) => message.role === 'assistant').length ?? 0;
      }, { timeout: (LIVE_PLANNER_TIMEOUT_SECONDS + 15) * 1000 }).toBeGreaterThan(0);
      await expect(page.getByTestId('invoker-terminal-transcript')).toContainText('READY_TO_DRAFT_BLACK_TO_PINK', {
        timeout: 10000,
      });
      await expect(page.getByText('Planning stopped. Try again when ready.')).toHaveCount(0);

      await submitPlanningText(page, [
        'Continue this same planning conversation and draft the complete Invoker YAML plan now.',
        `Use exactly this repoUrl: ${E2E_REPO_URL}`,
        `Use exactly this plan name with no trailing punctuation: ${LIVE_PROOF_PLAN_NAME}`,
        'Task: change all black colors to pink.',
        'Use exactly one task with id change-black-to-pink and command "echo change-black-to-pink".',
        'Set onFinish: none. Do not create stacked workflows. Return the YAML draft.',
      ].join('\n'));

      await expect(page.getByTestId('invoker-terminal-ready-bar')).toContainText(
        'Draft ready',
        { timeout: (LIVE_PLANNER_TIMEOUT_SECONDS + 15) * 1000 },
      );
      await expect.poll(async () => page.evaluate(async (sinceId) => {
        const logs = await window.invoker.getActivityLogs(sinceId, 2000);
        return logs
          .filter((entry) => entry.message.includes('planner_session_id_promoted'))
          .map((entry) => entry.message)
          .join('\n');
      }, activityLogWatermark), {
        timeout: 10000,
        message: 'activity log contains planner_session_id_promoted',
      }).toContain('planner_session_id_promoted');
      const activityLogs = await page.evaluate(async (sinceId) => window.invoker.getActivityLogs(sinceId, 2000), activityLogWatermark);
      await testInfo.attach('live-planning-activity-log.json', {
        body: Buffer.from(JSON.stringify(activityLogs, null, 2)),
        contentType: 'application/json',
      });
      expect(activityLogs.map((entry) => entry.message).join('\n')).not.toContain('thread/resume failed');
      const draftSessionId = await page.evaluate(async () => {
        const list = await window.invoker.planningChatList();
        return list.sessions.find((session) => session.status === 'draft_ready' && session.draftPlanAvailable)?.id ?? null;
      });
      expect(draftSessionId).toBeTruthy();

      await page.getByTestId('invoker-terminal-review-draft').click();
      await expect(page.getByTestId('draft-raw-yaml')).toContainText(E2E_REPO_URL);
      await expect(page.getByTestId('draft-raw-yaml')).toContainText('change-black-to-pink');
      await page.getByTestId('planning-create-workflow').click();

      await expect.poll(async () => {
        const list = await page!.evaluate(async () => window.invoker.planningChatList());
        return list.sessions.find((session) => session.id === draftSessionId)?.status ?? null;
      }, { timeout: 30000 }).toBe('submitted');

      await expect.poll(async () => {
        const workflows = await page!.evaluate(async () => window.invoker.listWorkflows());
        return workflows.some((workflow) => workflow.name === LIVE_PROOF_PLAN_NAME);
      }, { timeout: 30000 }).toBe(true);

      if (LIVE_PROOF_SCREENSHOT) {
        mkdirSync(path.dirname(LIVE_PROOF_SCREENSHOT), { recursive: true });
        await page.screenshot({ path: LIVE_PROOF_SCREENSHOT, fullPage: true });
      }
    } finally {
      await attachPlanningState(page, testInfo, codexPath).catch(() => undefined);
      if (app) await closeApp(app).catch(() => undefined);
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  });
});

import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

/**
 * e2e proof for the 2026-08-02 fix-ci retry storm (~$1,032 in one 24h
 * window, one task retried 78 times on the same unresolved commit).
 *
 * Root cause: LAUNCH_STUCK_ABANDON_MS (12 minutes in production, shrunk
 * here via INVOKER_LAUNCH_DISPATCH_LEASE_MS) was only ever meant to catch a
 * launch that never starts. A 2026-07-27 commit moved completeDispatch()
 * to only fire once a task's WHOLE run finishes, so any task whose real
 * work legitimately outlives the window got torn down and relaunched from
 * scratch, forever, on a fixed cadence.
 *
 * "does not tear down a healthy task that outlives the stuck-launch window"
 * proves that root cause end to end through the real app: a task running a
 * long-but-healthy command must not get a second attempt while the first
 * is still alive.
 *
 * "eventually gives up on a launch that never starts" proves the
 * companion stopper: a launch that genuinely never completes handoff must
 * not retry forever either.
 */

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

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

function findTask(tasks: Array<{ id: string; status: string }>, taskId: string) {
  return tasks.find((task) => task.id === taskId || task.id.endsWith(`/${taskId}`));
}

async function launchApp(testDir: string, extraEnv: Record<string, string>): Promise<{ app: ElectronApplication; page: Page }> {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const electronUserDataDir = path.join(testDir, 'electron-user-data');
  registerTrackedBrowserUserDataDir(electronUserDataDir);
  writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: false }), 'utf8');

  const app = await electron.launch({
    args: [`--user-data-dir=${electronUserDataDir}`, ...launchArgs()],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_GUI_OWNER_MODE: 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_ALLOW_DELETE_ALL: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_STARTUP_POLL_DELAY_MS: '0',
      INVOKER_USER_DATA_DIR: electronUserDataDir,
      ...extraEnv,
    },
  });
  const page = await app.firstWindow();
  await waitForInvoker(page);
  await page.evaluate(() => window.invoker.reportUiPerf?.('startup_graph_visible', {}));
  await page.evaluate(async () => {
    await window.invoker.clear();
    await window.invoker.deleteAllWorkflows();
  });
  return { app, page };
}

async function waitForTask(
  page: Page,
  taskId: string,
  predicate: (task: any) => boolean,
  timeoutMs: number,
): Promise<any | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: any | undefined;
  while (Date.now() < deadline) {
    const snapshot = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
    last = findTask(tasks, taskId);
    if (last && predicate(last)) return last;
    await page.waitForTimeout(200);
  }
  return last;
}

base.describe('Launch-dispatch stuck-lease reaper', () => {
  // Expected to fail until the next slice in this stack lands
  // acceptDispatch(): completeDispatch() currently only fires once a
  // task's WHOLE run finishes, so LAUNCH_STUCK_ABANDON_MS (shrunk here)
  // wrongly treats a still-running, still-healthy task as stuck in launch.
  base.fail('does not tear down a healthy task that outlives the stuck-launch window', async () => {
    // Shrunk to 3s (production default is 12 minutes) so the reaper's
    // 2s poll tick gets at least one real chance to misfire within the
    // test's window if the bug is present.
    const LEASE_MS = 3000;
    const SLEEP_SECONDS = 8;

    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-healthy-long-task-'));
    let app: ElectronApplication | undefined;
    try {
      const launched = await launchApp(testDir, { INVOKER_LAUNCH_DISPATCH_LEASE_MS: String(LEASE_MS) });
      app = launched.app;
      const page = launched.page;

      const plan = {
        name: 'Healthy long-running task',
        repoUrl: E2E_REPO_URL,
        onFinish: 'none' as const,
        tasks: [
          {
            id: 'healthy-long-task',
            description: 'runs longer than the stuck-launch window but is healthy',
            command: `sleep ${SLEEP_SECONDS}`,
          },
        ],
      };
      await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(plan));

      const running = await waitForTask(page, 'healthy-long-task', (t) => t.status === 'running', 15_000);
      expect(running, 'task should reach running').toBeDefined();
      const initialAttemptId = running.execution?.selectedAttemptId;
      const initialGeneration = running.execution?.generation ?? 0;
      expect(initialAttemptId).toBeTruthy();

      // Watch across more than 2x the stuck-launch window while the sleep
      // is still in flight. A healthy task must keep its original attempt
      // the whole time -- if the reaper wrongly reaps it, a fresh attempt
      // (new selectedAttemptId / bumped generation) appears here, still
      // while the original sleep has not had time to finish.
      const watchDeadline = Date.now() + LEASE_MS * 2 + 1500;
      let observedReset: any | undefined;
      while (Date.now() < watchDeadline) {
        const snapshot = await page.evaluate(() => window.invoker.getTasks());
        const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
        const current = findTask(tasks, 'healthy-long-task');
        if (
          current
          && (current.execution?.generation ?? 0) > initialGeneration
        ) {
          observedReset = current;
          break;
        }
        if (current?.status === 'completed' || current?.status === 'failed') break;
        await page.waitForTimeout(200);
      }

      expect(
        observedReset,
        `task must not be reset while its command is still healthily running (saw generation bump to ${observedReset?.execution?.generation}, ` +
          `attempt ${observedReset?.execution?.selectedAttemptId} instead of original ${initialAttemptId})`,
      ).toBeUndefined();

      // The original single attempt should go on to finish normally.
      const finished = await waitForTask(
        page,
        'healthy-long-task',
        (t) => t.status === 'completed' || t.status === 'failed',
        (SLEEP_SECONDS + 10) * 1000,
      );
      expect(finished?.status).toBe('completed');
      expect(finished?.execution?.selectedAttemptId).toBe(initialAttemptId);
    } finally {
      await app?.close().catch(() => undefined);
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

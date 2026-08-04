import { test as base, _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { registerTrackedBrowserUserDataDir } from './fixtures/browser-process-registry.js';

/**
 * e2e proof that a launch which genuinely never completes handoff (SSH
 * hang, worktree setup hang, ...) stops retrying instead of retrying
 * forever. This is the companion stopper to
 * launch-dispatch-stuck-lease-storm.spec.ts, which proves the more common
 * case (a healthy task that just runs long). Both matter: fixing only the
 * healthy-task case still leaves a genuinely-stuck launch retrying forever
 * on the same ~12-minute cadence the 2026-08-02 fix-ci storm showed.
 *
 * Uses INVOKER_E2E_HANG_LAUNCH_STARTUP_MS (worktree-executor.ts) to make
 * executor.start() hang well past several shrunk stuck-launch windows,
 * so the launch never reaches markTaskRunningAfterLaunch and acceptDispatch
 * is never called -- the row stays genuinely "stuck in launch" the whole
 * run, unlike the healthy-task test.
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

base.describe('Launch-dispatch stuck-lease retry cap', () => {
  base('eventually gives up on a launch that never completes handoff', async () => {
    const LEASE_MS = 1500;
    // Long enough to outlast MAX_STUCK_LEASE_RETRIES (5) reap cycles at
    // ~LEASE_MS + one 2s poll tick each (worst case ~5 * 3.5s = 17.5s),
    // short enough to keep the test fast.
    const HANG_MS = 30_000;
    const MAX_STUCK_LEASE_RETRIES = 5;

    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-stuck-launch-cap-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
    const electronUserDataDir = path.join(testDir, 'electron-user-data');
    registerTrackedBrowserUserDataDir(electronUserDataDir);
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: false }), 'utf8');
    let app: ElectronApplication | undefined;

    try {
      app = await electron.launch({
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
          INVOKER_LAUNCH_DISPATCH_LEASE_MS: String(LEASE_MS),
          INVOKER_EXECUTOR_START_TIMEOUT_MS: String(HANG_MS * 2),
          INVOKER_E2E_HANG_LAUNCH_STARTUP_MS: String(HANG_MS),
        },
      });
      const page = await app.firstWindow();
      await waitForInvoker(page);
      await page.evaluate(() => window.invoker.reportUiPerf?.('startup_graph_visible', {}));
      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });

      const plan = {
        name: 'Launch never completes handoff',
        repoUrl: E2E_REPO_URL,
        onFinish: 'none' as const,
        tasks: [
          {
            id: 'stuck-launch-task',
            description: 'executor.start() hangs -- launch handoff never completes',
            command: 'echo unreachable',
          },
        ],
      };
      await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(plan));

      // Watch generation for well past the point where an unbounded reaper
      // would have retried many times (5 cycles * ~3.5s ~= 17.5s), then
      // confirm it has stopped growing and the exhaustion signal fired.
      const watchDeadline = Date.now() + HANG_MS - 5_000;
      let maxGenerationSeen = 0;
      let sawExhaustedLog = false;
      const generationSamples: number[] = [];
      while (Date.now() < watchDeadline && !sawExhaustedLog) {
        const snapshot = await page.evaluate(() => window.invoker.getTasks());
        const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
        const current = findTask(tasks, 'stuck-launch-task');
        const gen = current?.execution?.generation ?? 0;
        if (gen !== maxGenerationSeen) {
          maxGenerationSeen = gen;
          generationSamples.push(gen);
        }
        const logs = await page.evaluate(() => window.invoker.getActivityLogs());
        sawExhaustedLog = logs.some(
          (entry: any) =>
            typeof entry.message === 'string'
            && entry.message.includes('stuck-lease retry budget exhausted'),
        );
        await page.waitForTimeout(300);
      }

      expect(sawExhaustedLog, `retry budget exhaustion signal should fire; generation samples seen: ${generationSamples.join(', ')}`).toBe(true);

      // Once exhausted, the generation must not keep climbing. Confirm by
      // sampling again after a further delay comfortably longer than one
      // more reap cycle would take.
      const generationAtExhaustion = maxGenerationSeen;
      await page.waitForTimeout(LEASE_MS + 3_000);
      const afterSnapshot = await page.evaluate(() => window.invoker.getTasks());
      const afterTasks = Array.isArray(afterSnapshot) ? afterSnapshot : afterSnapshot.tasks;
      const afterTask = findTask(afterTasks, 'stuck-launch-task');
      expect(
        afterTask?.execution?.generation ?? 0,
        'generation must not climb further once the retry budget is exhausted',
      ).toBe(generationAtExhaustion);

      // The stopper is a hard cap on retries, not just "eventually stops
      // *somewhere*" -- confirm it actually gave up at MAX_STUCK_LEASE_RETRIES,
      // not some much larger number.
      expect(generationAtExhaustion).toBeLessThanOrEqual(MAX_STUCK_LEASE_RETRIES + 1);
      expect(generationAtExhaustion).toBeGreaterThan(0);
    } finally {
      await app?.close().catch(() => undefined);
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

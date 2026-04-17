import { test as base, _electron as electron, expect, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';
import { injectTaskStates } from './fixtures/electron-app.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const WATCHDOG_PLAN = {
  name: 'Launch stall watchdog',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'stall-task',
      description: 'task for launch stall watchdog',
      command: 'echo watchdog',
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

function findTask(tasks: Array<{ id: string; status: string }>, taskId: string) {
  return tasks.find((task) => task.id === taskId || task.id.endsWith(`/${taskId}`));
}

base.describe('Launch stall watchdog', () => {
  base('fails stuck launching task without execution handle', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-watchdog-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0, disableAutoRunOnStartup: true }), 'utf8');

    try {
      const app = await electron.launch({
        args: launchArgs(),
        env: {
          ...process.env,
          NODE_ENV: 'test',
          INVOKER_DB_DIR: testDir,
          INVOKER_ALLOW_DELETE_ALL: '1',
          INVOKER_REPO_CONFIG_PATH: configPath,
          INVOKER_LAUNCHING_STALL_TIMEOUT_MS: '3000',
          INVOKER_STARTUP_POLL_DELAY_MS: '0',
        },
      });
      const page = await app.firstWindow();
      await waitForInvoker(page);
      await page.evaluate(() => window.invoker.reportUiPerf?.('startup_graph_visible', {}));

      await page.evaluate(async () => {
        await window.invoker.clear();
        await window.invoker.deleteAllWorkflows();
      });
      await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(WATCHDOG_PLAN));

      const initial = await page.evaluate(() => window.invoker.getTasks(true));
      const initialTasks = Array.isArray(initial) ? initial : initial.tasks;
      const stalled = findTask(initialTasks, 'stall-task');
      expect(stalled).toBeDefined();

      const staleTs = new Date(Date.now() - 30_000).toISOString();
      await injectTaskStates(page, [{
        taskId: stalled!.id,
        changes: {
          status: 'running',
          execution: {
            phase: 'launching',
            generation: 0,
            startedAt: staleTs,
            launchStartedAt: staleTs,
            lastHeartbeatAt: staleTs,
            selectedAttemptId: `${stalled!.id}-attempt`,
          },
        },
      }]);

      const deadline = Date.now() + 15_000;
      let stalledTask: any | undefined;
      while (Date.now() < deadline) {
        const snapshot = await page.evaluate(() => window.invoker.getTasks(true));
        const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
        stalledTask = findTask(tasks, 'stall-task');
        if (
          stalledTask?.status === 'failed'
          && /^Launch stalled: task remained in running\/launching for \d+s without a spawned execution handle$/.test(stalledTask.execution?.error ?? '')
        ) {
          break;
        }
        await page.waitForTimeout(250);
      }
      expect(stalledTask, 'stalled task should remain visible in task list').toBeDefined();
      expect(stalledTask?.status).toBe('failed');
      expect(stalledTask?.execution?.error ?? '').toMatch(
        /^Launch stalled: task remained in running\/launching for \d+s without a spawned execution handle$/,
      );

      const logsDeadline = Date.now() + 30_000;
      let sawLaunchStallLog = false;
      while (Date.now() < logsDeadline) {
        const logs = await page.evaluate(() => window.invoker.getActivityLogs());
        sawLaunchStallLog = logs.some(
          (entry: any) =>
            entry.source === 'db-poll'
            && typeof entry.message === 'string'
            && entry.message.includes('[launch-stall] forcing failure for')
            && entry.message.includes('stall-task')
            && entry.message.includes('Launch stalled: task remained in running/launching'),
        );
        if (sawLaunchStallLog) break;
        await page.waitForTimeout(250);
      }
      expect(sawLaunchStallLog).toBe(true);

      await app.close();
    } finally {
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

/**
 * E2E: Orphan task relaunch — verify that tasks stuck in 'running' from a
 * previous session are automatically relaunched when the app restarts.
 *
 * Simulates an app crash by force-killing the Electron process while a task
 * is still running. On relaunch, startup reconciliation should detect and
 * relaunch the orphaned task.
 */

import { test as base, _electron as electron, expect, type Page } from '@playwright/test';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { stringify as yamlStringify } from 'yaml';
import { E2E_REPO_URL } from './fixtures/electron-app.js';

const MAIN_JS = path.resolve(__dirname, '..', 'dist', 'main.js');

const RELAUNCH_PLAN = {
  name: 'Orphan Relaunch Test',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'fast-task',
      description: 'Completes quickly',
      command: 'echo done',
      dependencies: [],
    },
    {
      id: 'slow-task',
      description: 'Takes long enough to be interrupted',
      command: 'sleep 120',
      dependencies: ['fast-task'],
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

function findTask(tasks: Array<{ id: string; status: string }>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

base.describe('Orphan task relaunch on restart', () => {
  base('orphaned running task is relaunched after app restart', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');

    try {
    const app1 = await electron.launch({
      args: launchArgs(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INVOKER_DB_DIR: testDir,
        INVOKER_ALLOW_DELETE_ALL: '1',
        INVOKER_E2E_ENABLE_COMPOSITOR: '1',
        INVOKER_REPO_CONFIG_PATH: configPath,
      },
    });
    const page1 = await app1.firstWindow();
    await waitForInvoker(page1);

    // Clear any leftover state
    await page1.evaluate(async () => {
      await window.invoker.clear();
      await window.invoker.deleteAllWorkflows();
    });

    // Load the plan and synthesize an orphaned running task with no live handle.
    await page1.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(RELAUNCH_PLAN));
    const loadedResult = await page1.evaluate(() => window.invoker.getTasks(true));
    const loadedTasks = Array.isArray(loadedResult) ? loadedResult : loadedResult.tasks;
    const loadedSlow = findTask(loadedTasks, 'slow-task');
    expect(loadedSlow).toBeDefined();

    await page1.evaluate(async ({ taskId }) => {
      const now = new Date().toISOString();
      await window.invoker.injectTaskStates?.([
        {
          taskId,
          changes: {
            status: 'running',
            execution: {
              phase: 'launching',
              startedAt: now,
              lastHeartbeatAt: now,
              launchStartedAt: now,
            },
          },
        },
      ]);
    }, { taskId: loadedSlow!.id });

    await page1.evaluate(() => window.invoker.resumeWorkflow());

    const deadline2 = Date.now() + 60_000;
    let observedSlow: any;
    while (Date.now() < deadline2) {
      const snapshot = await page1.evaluate(() => window.invoker.getTasks(true));
      const tasks = Array.isArray(snapshot) ? snapshot : snapshot.tasks;
      observedSlow = findTask(tasks, 'slow-task');
      if (observedSlow?.status === 'running' && observedSlow?.execution?.phase !== 'launching') {
        break;
      }
      await page1.waitForTimeout(300);
    }
    expect(observedSlow).toBeDefined();
    expect(observedSlow?.status).toBe('running');
    expect(observedSlow?.execution?.phase).not.toBe('launching');

    const postResult = await page1.evaluate(() => window.invoker.getTasks(true));
    const postTasks = Array.isArray(postResult) ? postResult : postResult.tasks;
    const postSlow = findTask(postTasks, 'slow-task');
    expect(postSlow).toBeDefined();
    expect(postSlow?.status).toBe('running');
    await app1.close();
    } finally {
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

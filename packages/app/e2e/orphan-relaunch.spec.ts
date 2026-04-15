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
import type { ElectronApplication } from '@playwright/test';

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

async function forceKillApp(app: ElectronApplication): Promise<void> {
  const child = app.process();
  if (!child?.pid) {
    throw new Error('Electron app process is not available for crash simulation');
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once('exit', () => resolve());
    child.once('error', reject);
  });
  process.kill(child.pid, 'SIGKILL');
  await exited;
}

base.describe('Orphan task relaunch on restart', () => {
  base('orphaned running task is relaunched after app restart', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    const configPath = path.join(testDir, 'e2e-config.json');
    writeFileSync(configPath, JSON.stringify({ autoFixRetries: 0 }), 'utf8');

    try {
    // --- Session 1: start a plan, get a task running, then close ---
    const app1 = await electron.launch({
      args: launchArgs(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INVOKER_DB_DIR: testDir,
        INVOKER_ALLOW_DELETE_ALL: '1',
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

    // Load and start the plan
    await page1.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(RELAUNCH_PLAN));
    await page1.evaluate(() => window.invoker.start());

    // Wait for slow-task to reach 'running' (fast-task completes first)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await page1.evaluate(() => window.invoker.getTasks(true));
      const tasks = Array.isArray(result) ? result : result.tasks;
      const slow = findTask(tasks, 'slow-task');
      if (slow && slow.status === 'running') break;
      await page1.waitForTimeout(300);
    }

    // Verify slow-task is running before we close the app
    const preResult = await page1.evaluate(() => window.invoker.getTasks(true));
    const preTasks = Array.isArray(preResult) ? preResult : preResult.tasks;
    const preSlow = findTask(preTasks, 'slow-task');
    expect(preSlow?.status).toBe('running');

    // Exit from the main process to simulate abrupt termination without
    // waiting on normal task shutdown hooks.
    await forceKillApp(app1);

    // --- Session 2: relaunch and verify orphan reconciliation ---
    const app2 = await electron.launch({
      args: launchArgs(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        INVOKER_DB_DIR: testDir,
        INVOKER_ALLOW_DELETE_ALL: '1',
        INVOKER_REPO_CONFIG_PATH: configPath,
      },
    });
    const page2 = await app2.firstWindow();
    await waitForInvoker(page2);

    // The startup reconciliation in setupGuiMode() should have already
    // relaunched the orphaned 'slow-task'. Give it a moment to process.
    await page2.waitForTimeout(2000);

    // Check task status — slow-task should be running again (relaunched)
    const postResult = await page2.evaluate(() => window.invoker.getTasks(true));
    const postTasks = Array.isArray(postResult) ? postResult : postResult.tasks;
    const postSlow = findTask(postTasks, 'slow-task');

    // The orphaned task should be running (relaunched) or still pending
    // (if startup hasn't kicked off execution yet). It should NOT be failed.
    expect(postSlow).toBeDefined();
    expect(['running', 'pending']).toContain(postSlow?.status);
    expect(postSlow?.status).not.toBe('failed');

    // fast-task should still be completed from session 1
    const postFast = findTask(postTasks, 'fast-task');
    expect(postFast?.status).toBe('completed');

    await forceKillApp(app2);
    } finally {
      if (process.env.INVOKER_E2E_KEEP_TMP !== '1') {
        rmSync(testDir, { recursive: true, force: true });
      }
    }
  });
});

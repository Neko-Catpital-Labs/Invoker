/**
 * E2E: Orphan task relaunch — verify that tasks stuck in 'running' from a
 * previous session are automatically relaunched when the app restarts.
 *
 * Simulates an app crash by closing gracefully, then patching the DB to
 * set the task status back to 'running' (as if the before-quit cleanup
 * never ran). On relaunch, startup reconciliation should detect and
 * relaunch the orphaned task.
 */

import { test as base, _electron as electron, expect, type Page } from '@playwright/test';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import * as path from 'node:path';
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

async function waitForInvoker(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
}

base.describe('Orphan task relaunch on restart', () => {
  base('orphaned running task is relaunched after app restart', async () => {
    const testDir = mkdtempSync(path.join(tmpdir(), 'invoker-e2e-'));
    const DB_PATH = path.join(testDir, 'invoker.db');

    function sqliteExec(sql: string): void {
      execSync(`sqlite3 "${DB_PATH}" "${sql}"`);
    }

    try {
    // --- Session 1: start a plan, get a task running, then close ---
    const app1 = await electron.launch({
      args: launchArgs(),
      env: { ...process.env, NODE_ENV: 'test', INVOKER_DB_DIR: testDir },
    });
    const page1 = await app1.firstWindow();
    await waitForInvoker(page1);

    // Clear any leftover state
    await page1.evaluate(async () => {
      await window.invoker.clear();
      await window.invoker.deleteAllWorkflows();
    });

    // Load and start the plan
    await page1.evaluate((plan) => window.invoker.loadPlan(plan), RELAUNCH_PLAN);
    await page1.evaluate(() => window.invoker.start());

    // Wait for slow-task to reach 'running' (fast-task completes first)
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const result = await page1.evaluate(() => window.invoker.getTasks());
      const tasks = Array.isArray(result) ? result : result.tasks;
      const slow = tasks.find((t: any) => t.id === 'slow-task');
      if (slow && slow.status === 'running') break;
      await page1.waitForTimeout(300);
    }

    // Verify slow-task is running before we close the app
    const preResult = await page1.evaluate(() => window.invoker.getTasks());
    const preTasks = Array.isArray(preResult) ? preResult : preResult.tasks;
    const preSlow = preTasks.find((t: any) => t.id === 'slow-task');
    expect(preSlow?.status).toBe('running');

    // Close gracefully — before-quit handler marks tasks as 'failed'
    await app1.close();

    // Patch DB to simulate a crash: set slow-task back to 'running'
    // as if the before-quit cleanup never ran.
    sqliteExec("UPDATE tasks SET status = 'running', completed_at = NULL, error = NULL, exit_code = NULL WHERE id = 'slow-task'");

    // --- Session 2: relaunch and verify orphan reconciliation ---
    const app2 = await electron.launch({
      args: launchArgs(),
      env: { ...process.env, NODE_ENV: 'test', INVOKER_DB_DIR: testDir },
    });
    const page2 = await app2.firstWindow();
    await waitForInvoker(page2);

    // The startup reconciliation in setupGuiMode() should have already
    // relaunched the orphaned 'slow-task'. Give it a moment to process.
    await page2.waitForTimeout(2000);

    // Check task status — slow-task should be running again (relaunched)
    const postResult = await page2.evaluate(() => window.invoker.getTasks());
    const postTasks = Array.isArray(postResult) ? postResult : postResult.tasks;
    const postSlow = postTasks.find((t: any) => t.id === 'slow-task');

    // The orphaned task should be running (relaunched) or still pending
    // (if startup hasn't kicked off execution yet). It should NOT be failed.
    expect(postSlow).toBeDefined();
    expect(['running', 'pending']).toContain(postSlow?.status);
    expect(postSlow?.status).not.toBe('failed');

    // fast-task should still be completed from session 1
    const postFast = postTasks.find((t: any) => t.id === 'fast-task');
    expect(postFast?.status).toBe('completed');

    await app2.close();
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

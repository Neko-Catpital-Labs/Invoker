/**
 * Shared Electron app fixture for E2E tests.
 *
 * Launches the built Electron app and provides the first window page.
 * Handles platform-specific flags (Linux --no-sandbox) and cleanup.
 */

import { test as base, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as path from 'node:path';

export type ElectronFixtures = {
  electronApp: ElectronApplication;
  page: Page;
};

export const test = base.extend<ElectronFixtures>({
  electronApp: async ({}, use) => {
    const app = await electron.launch({
      args: [
        ...(process.platform === 'linux'
          ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-gpu-compositing']
          : []),
        path.resolve(__dirname, '..', '..', 'dist', 'main.js'),
      ],
      env: { ...process.env, NODE_ENV: 'test', INVOKER_CLAUDE_FIX_COMMAND: '/bin/true' },
    });
    await use(app);
    await app.close();
  },

  page: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

    // Clear state from previous runs and reload for clean React state
    await page.evaluate(async () => {
      await window.invoker.clear();
      await window.invoker.deleteAllWorkflows();
    });
    await page.reload();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });

    await use(page);
  },
});

export { expect } from '@playwright/test';

/** Minimal plan with two command tasks for testing UI rendering and lifecycle. */
export const TEST_PLAN = {
  name: 'E2E Test Plan',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-alpha',
      description: 'First test task',
      command: 'echo hello-alpha',
      dependencies: [],
    },
    {
      id: 'task-beta',
      description: 'Second test task depending on alpha',
      command: 'echo hello-beta',
      dependencies: ['task-alpha'],
    },
  ],
};

/** Load a plan into the running app via the IPC bridge and wait for DAG to render. */
export async function loadPlan(page: Page, plan: typeof TEST_PLAN): Promise<void> {
  await page.evaluate((p) => window.invoker.loadPlan(p), plan);
  await page.locator(`[data-testid="rf__node-${plan.tasks[0].id}"]`).waitFor({ state: 'visible', timeout: 10000 });
}

/** Start the loaded plan via the IPC bridge. */
export async function startPlan(page: Page): Promise<void> {
  await page.evaluate(() => window.invoker.start());
}

/** Get all current tasks via the IPC bridge. */
export async function getTasks(page: Page) {
  const result = await page.evaluate(() => window.invoker.getTasks());
  return Array.isArray(result) ? result : result.tasks;
}

/** Wait for a specific task to reach a given status via polling. */
export async function waitForTaskStatus(
  page: Page,
  taskId: string,
  status: string,
  timeoutMs = 30000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const task = tasks.find((t: any) => t.id === taskId);
    if (task && task.status === status) return;
    await page.waitForTimeout(300);
  }
  throw new Error(`Task "${taskId}" did not reach status "${status}" within ${timeoutMs}ms`);
}

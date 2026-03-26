/**
 * E2E: Visual proof capture.
 *
 * Captures screenshots at key UI states for before/after comparison in PRs.
 * When CAPTURE_MODE env var is set, screenshots are saved to disk.
 * Always validates UI state via DOM assertions so it doubles as a regression test.
 */

import {
  test,
  expect,
  TEST_PLAN,
  loadPlan,
  injectTaskStates,
  captureScreenshot,
} from './fixtures/electron-app.js';

test.describe('Visual proof capture', () => {
  test('empty state', async ({ page }) => {
    await expect(page.getByText('Load a plan to get started')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Open File')).toBeVisible();
    await expect(page.getByText('Refresh')).toBeVisible();
    await expect(page.getByText('Clear')).toBeVisible();
    await captureScreenshot(page, 'empty-state');
  });

  test('dag loaded', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('[data-testid="rf__node-task-alpha"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'dag-loaded');
  });

  test('task running', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);
    await captureScreenshot(page, 'task-running');
  });

  test('task complete', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
    ]);
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const workTasks = tasks.filter((t: { id: string }) => !t.id.startsWith('__merge__'));
    expect(workTasks.every((t: { status: string }) => t.status === 'completed')).toBe(true);
    await captureScreenshot(page, 'task-complete');
  });

  test('task panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.locator('[data-testid="rf__node-task-alpha"]').click();
    await expect(page.getByRole('heading', { name: 'First test task' })).toBeVisible();
    const panel = page.locator('.overflow-y-auto');
    await expect(panel.locator('text=task-alpha')).toBeVisible();
    await captureScreenshot(page, 'task-panel');
  });
});

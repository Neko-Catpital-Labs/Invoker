/**
 * E2E: Visual proof capture.
 *
 * Captures screenshots at key UI states for before/after comparison in PRs.
 * When CAPTURE_MODE env var is set, screenshots are saved to disk.
 * Always validates UI state via DOM assertions so it doubles as a regression test.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';
import { captureScreenshot } from './fixtures/electron-app.js';

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
    await startPlan(page);
    await page.waitForTimeout(500);
    await captureScreenshot(page, 'task-running');
  });

  test('task complete', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed', 30000);
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    expect(tasks.every((t: any) => t.status === 'completed')).toBe(true);
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

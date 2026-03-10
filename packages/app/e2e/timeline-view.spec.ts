/**
 * E2E: Timeline view — verify the timeline tab renders task bars
 * and supports interaction.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

test.describe('Timeline view', () => {
  test('clicking Timeline button shows the timeline view', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.getByRole('button', { name: 'Timeline' }).click();
    await expect(page.locator('[data-testid="timeline-view"]')).toBeVisible({ timeout: 5000 });
  });

  test('timeline shows task bars after loading a plan', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.getByRole('button', { name: 'Timeline' }).click();

    await expect(page.locator('[data-testid="timeline-bar-task-alpha"]')).toBeVisible({ timeout: 5000 });
    await expect(page.locator('[data-testid="timeline-bar-task-beta"]')).toBeVisible({ timeout: 5000 });
  });

  test('running tasks show elapsed time', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.getByRole('button', { name: 'Timeline' }).click();
    await startPlan(page);

    await waitForTaskStatus(page, 'task-alpha', 'completed');

    const alphaBar = page.locator('[data-testid="timeline-bar-task-alpha"]');
    await expect(alphaBar).toContainText(/\d+s/);
  });

  test('clicking a task bar selects it in the task panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.getByRole('button', { name: 'Timeline' }).click();

    await page.locator('[data-testid="timeline-bar-task-alpha"]').click();
    await expect(page.getByText('task-alpha')).toBeVisible({ timeout: 5000 });
  });

  test('switching back to DAG view works', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.getByRole('button', { name: 'Timeline' }).click();
    await expect(page.locator('[data-testid="timeline-view"]')).toBeVisible({ timeout: 5000 });

    await page.getByRole('button', { name: 'DAG' }).click();
    await expect(page.locator('[data-testid="timeline-view"]')).not.toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-alpha"]')).toBeVisible({ timeout: 5000 });
  });
});

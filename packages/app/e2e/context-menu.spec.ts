/**
 * E2E: Context menu on task nodes.
 *
 * Tests right-clicking DAG nodes to show context menu with
 * Restart Task and Open Terminal options.
 * Regression: context menu was added in commit f82a97b.
 */

import { test, expect, TEST_PLAN, loadPlan } from './fixtures/electron-app.js';

test.describe('Context menu', () => {
  test('right-clicking a task node shows context menu', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });

    await expect(page.getByText('Restart Task')).toBeVisible({ timeout: 2000 });
    await expect(page.getByText('Open Terminal')).toBeVisible({ timeout: 2000 });
  });

  test('Escape closes the context menu', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });
    await expect(page.getByText('Restart Task')).toBeVisible({ timeout: 2000 });

    await page.keyboard.press('Escape');
    await expect(page.getByText('Restart Task')).not.toBeVisible({ timeout: 2000 });
  });

  test('clicking outside closes the context menu', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });
    await expect(page.getByText('Restart Task')).toBeVisible({ timeout: 2000 });

    // Click on the background
    await page.locator('body').click({ position: { x: 10, y: 10 }, force: true });
    await expect(page.getByText('Restart Task')).not.toBeVisible({ timeout: 2000 });
  });

  test('Restart Task is enabled for pending tasks', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });
    const restartBtn = page.locator('button').filter({ hasText: 'Restart Task' });
    await expect(restartBtn).toBeVisible({ timeout: 2000 });
    // pending tasks can be restarted (canRestart = status !== 'running')
    await expect(restartBtn).toBeEnabled();
  });

  test('clicking Restart Task closes the context menu', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });

    const restartBtn = page.locator('button').filter({ hasText: 'Restart Task' });
    await expect(restartBtn).toBeVisible({ timeout: 2000 });
    await restartBtn.click();

    await expect(page.getByText('Restart Task')).not.toBeVisible({ timeout: 2000 });
  });

  test('Open Terminal option is always enabled', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click({ button: 'right' });
    const openTermBtn = page.locator('button').filter({ hasText: 'Open Terminal' });
    await expect(openTermBtn).toBeVisible({ timeout: 2000 });
    await expect(openTermBtn).toBeEnabled();
  });
});

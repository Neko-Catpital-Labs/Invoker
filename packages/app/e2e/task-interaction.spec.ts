/**
 * E2E: Task interaction — clicking nodes, TaskPanel, terminal.
 *
 * Tests clicking DAG nodes to select tasks, viewing details in the TaskPanel,
 * and terminal output display.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

test.describe('Task interaction', () => {
  test('clicking a task node shows its details in the TaskPanel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click();

    // TaskPanel should show the heading (not the DAG node text)
    await expect(page.getByRole('heading', { name: 'First test task' })).toBeVisible();
    // Task ID should appear in the panel
    const panel = page.locator('.overflow-y-auto');
    await expect(panel.locator('text=task-alpha')).toBeVisible();
  });

  test('clicking a task node expands the terminal', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click();

    // Terminal header should show task-alpha
    const toggleBar = page.locator('button').filter({ hasText: 'task-alpha' });
    await expect(toggleBar).toBeVisible({ timeout: 3000 });
  });

  test('TaskPanel shows command type for command tasks', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click();

    await expect(page.getByText('Command')).toBeVisible();
    await expect(page.getByText('echo hello-alpha')).toBeVisible();
  });

  test('TaskPanel shows dependencies for dependent tasks', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-beta"]').click();

    await expect(page.getByText('Dependencies')).toBeVisible();
    // task-alpha should show as a dependency
    const depsSection = page.locator('text=Dependencies').locator('..');
    await expect(depsSection.getByText('task-alpha')).toBeVisible();
  });

  test('terminal shows xterm after task is selected', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click();

    // xterm should mount when the terminal expands
    const xtermScreen = page.locator('.xterm-screen');
    await expect(xtermScreen).toBeVisible({ timeout: 5000 });
  });

  test('clicking different tasks switches terminal header', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    await page.locator('[data-testid="rf__node-task-alpha"]').click();
    await expect(page.locator('button').filter({ hasText: 'task-alpha' })).toBeVisible();

    await page.locator('[data-testid="rf__node-task-beta"]').click();
    await expect(page.locator('button').filter({ hasText: 'task-beta' })).toBeVisible();
  });
});

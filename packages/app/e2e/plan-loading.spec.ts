/**
 * E2E: Plan loading and DAG rendering.
 *
 * Loads a plan via IPC and verifies the DAG visualizes correctly
 * with task nodes and correct state.
 */

import { test, expect, TEST_PLAN, loadPlan } from './fixtures/electron-app.js';

test.describe('Plan loading', () => {
  test('loading a plan renders task nodes in the DAG', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    const alphaNode = page.locator('[data-testid="rf__node-task-alpha"]');
    const betaNode = page.locator('[data-testid="rf__node-task-beta"]');
    await expect(alphaNode).toBeVisible();
    await expect(betaNode).toBeVisible();
  });

  test('tasks are in pending state after loading', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    const tasks = await page.evaluate(() => window.invoker.getTasks());
    expect(tasks.length).toBe(2);
    expect(tasks.every((t: any) => t.status === 'pending')).toBe(true);
  });

  test('empty state message disappears after loading a plan', async ({ page }) => {
    // Verify empty state first
    await expect(page.getByText('Load a plan to get started')).toBeVisible({ timeout: 5000 });

    await loadPlan(page, TEST_PLAN);
    await expect(page.getByText('Load a plan to get started')).not.toBeVisible();
  });

  test('task nodes show descriptions', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    // Descriptions appear inside the DAG nodes
    const alphaNode = page.locator('[data-testid="rf__node-task-alpha"]');
    await expect(alphaNode.getByText('First test task')).toBeVisible();
  });

  test('task IDs appear in the DAG', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const alphaNode = page.locator('[data-testid="rf__node-task-alpha"]');
    await expect(alphaNode.getByText('task-alpha')).toBeVisible();
  });
});

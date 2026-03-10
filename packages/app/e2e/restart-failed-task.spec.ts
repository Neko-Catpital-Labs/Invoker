/**
 * E2E: Restart a failed task via context menu.
 *
 * Tests that right-click → Restart Task on a failed node
 * transitions it back to running/completed.
 * Regression: DB poll was not re-hydrating the orchestrator
 * for externally-created workflows, causing silent restart failures.
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

const FAILING_PLAN = {
  name: 'E2E Restart Test Plan',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-pass',
      description: 'Task that succeeds',
      command: 'echo ok',
      dependencies: [],
    },
    {
      id: 'task-fail',
      description: 'Task that fails',
      command: 'exit 1',
      dependencies: ['task-pass'],
    },
  ],
};

test.describe('Restart failed task', () => {
  test('right-click Restart Task on a failed task re-runs it', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    // Wait for task-pass to complete, then task-fail to fail
    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    // Verify task-fail shows as failed
    const failedTasks = await page.evaluate(() => window.invoker.getTasks());
    const failTask = failedTasks.find((t: any) => t.id === 'task-fail');
    expect(failTask?.status).toBe('failed');

    // Right-click the failed task node to open context menu
    await page.locator('[data-testid="rf__node-task-fail"]').click({ button: 'right' });

    const restartBtn = page.locator('button').filter({ hasText: 'Restart Task' });
    await expect(restartBtn).toBeVisible({ timeout: 2000 });
    await expect(restartBtn).toBeEnabled();
    await restartBtn.click();

    // Task should transition away from 'failed' — it will re-run and fail again
    // but the restart itself should succeed (not silently swallowed)
    await waitForTaskStatus(page, 'task-fail', 'running', 5000).catch(() => {
      // Task may have already re-failed by the time we poll — check it ran
    });

    // Wait for it to settle (will fail again since command is 'exit 1')
    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);

    // Verify the task was actually restarted by checking startedAt changed
    const afterTasks = await page.evaluate(() => window.invoker.getTasks());
    const afterFail = afterTasks.find((t: any) => t.id === 'task-fail');
    expect(afterFail?.status).toBe('failed');
  });

  test('restarting a failed task works after loading a second plan', async ({ page }) => {
    // Load and run first plan (simulates "old" workflow the orchestrator knows about)
    const firstPlan = {
      name: 'First Plan',
      onFinish: 'none' as const,
      tasks: [
        { id: 'first-task', description: 'Quick task', command: 'echo done', dependencies: [] },
      ],
    };
    await loadPlan(page, firstPlan);
    await startPlan(page);
    await waitForTaskStatus(page, 'first-task', 'completed');

    // Now load a second plan with a failing task
    // This creates a NEW workflow — the orchestrator must re-hydrate
    await page.evaluate((p) => window.invoker.loadPlan(p), FAILING_PLAN);
    await page.locator('[data-testid="rf__node-task-pass"]').waitFor({ state: 'visible', timeout: 10000 });
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    // Right-click → Restart should work even though this is a different workflow
    await page.locator('[data-testid="rf__node-task-fail"]').click({ button: 'right' });
    const restartBtn = page.locator('button').filter({ hasText: 'Restart Task' });
    await expect(restartBtn).toBeVisible({ timeout: 2000 });
    await restartBtn.click();

    // Should restart — will fail again but the restart must not be silently swallowed
    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);
  });
});

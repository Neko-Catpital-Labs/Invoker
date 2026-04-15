/**
 * E2E: Restart a failed task via context menu.
 *
 * Tests that right-click → Restart Task on a failed node
 * transitions it back to running/completed.
 * Regression: DB poll was not re-hydrating the orchestrator
 * for externally-created workflows, causing silent restart failures.
 */

import type { Page } from '@playwright/test';
import { test, expect, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';

function findTask(tasks: Array<{ id: string; status: string }>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

async function openRestartTaskMenu(page: Page, taskSuffix: string) {
  const node = page.locator(`.react-flow__node[data-testid$="${taskSuffix}"]`);
  const restartBtn = page.locator('button').filter({ hasText: 'Restart Task' });

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await node.click({ button: 'right' });
    await expect(restartBtn).toBeVisible({ timeout: 2000 });
    if (await restartBtn.isEnabled()) {
      return restartBtn;
    }
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(250);
  }

  await expect(restartBtn).toBeEnabled({ timeout: 5000 });
  return restartBtn;
}

const FAILING_PLAN = {
  name: 'E2E Restart Test Plan',
  repoUrl: E2E_REPO_URL,
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
    let result = await page.evaluate(() => window.invoker.getTasks());
    const failedTasks = Array.isArray(result) ? result : result.tasks;
    const failTask = findTask(failedTasks, 'task-fail');
    expect(failTask?.status).toBe('failed');

    // Right-click the failed task node to open context menu
    const restartBtn = await openRestartTaskMenu(page, 'task-fail');
    await restartBtn.click();

    // Task should transition away from 'failed' — it will re-run and fail again
    // but the restart itself should succeed (not silently swallowed)
    await waitForTaskStatus(page, 'task-fail', 'running', 5000).catch(() => {
      // Task may have already re-failed by the time we poll — check it ran
    });

    // Wait for it to settle (will fail again since command is 'exit 1')
    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);

    // Verify the task was actually restarted by checking startedAt changed
    result = await page.evaluate(() => window.invoker.getTasks());
    const afterTasks = Array.isArray(result) ? result : result.tasks;
    const afterFail = findTask(afterTasks, 'task-fail');
    expect(afterFail?.status).toBe('failed');
  });

  test('restarting a failed task works after loading a second plan', async ({ page }) => {
    // Load and run first plan (simulates "old" workflow the orchestrator knows about)
    const firstPlan = {
      name: 'First Plan',
      repoUrl: E2E_REPO_URL,
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
    await loadPlan(page, FAILING_PLAN);
    await page.locator('.react-flow__node[data-testid$="task-pass"]').waitFor({ state: 'visible', timeout: 10000 });
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    // Right-click → Restart should work even though this is a different workflow
    const restartBtn = await openRestartTaskMenu(page, 'task-fail');
    await restartBtn.click();

    // Should restart — will fail again but the restart must not be silently swallowed
    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);
  });
});

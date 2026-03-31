/**
 * E2E: Fix with Claude workflow.
 *
 * Tests the full lifecycle:
 *   failed task -> right-click -> Fix with Claude -> awaiting_approval -> approve/reject
 *
 * Uses INVOKER_CLAUDE_FIX_COMMAND=/bin/true (set in fixture) so no real
 * Claude CLI is needed. /bin/true exits 0 with no output, which is
 * sufficient to test the state transitions.
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';

const FAILING_PLAN = {
  name: 'E2E Fix with Claude Plan',
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

test.describe('Fix with Claude', () => {
  test('Fix with Claude -> Approve -> task re-runs', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    await page.locator('[data-testid="rf__node-task-fail"]').click({ button: 'right' });
    const fixBtn = page.locator('button').filter({ hasText: 'Fix with Claude' });
    await expect(fixBtn).toBeVisible({ timeout: 2000 });
    await fixBtn.click();

    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate((id) => window.invoker.approve(id), 'task-fail');

    await waitForTaskStatus(page, 'task-fail', 'failed', 15000);
  });

  test('Fix with Claude -> Reject -> task reverts to failed', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    await page.locator('[data-testid="rf__node-task-fail"]').click({ button: 'right' });
    const fixBtn = page.locator('button').filter({ hasText: 'Fix with Claude' });
    await expect(fixBtn).toBeVisible({ timeout: 2000 });
    await fixBtn.click();

    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate((id) => window.invoker.reject(id), 'task-fail');

    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);
  });
});

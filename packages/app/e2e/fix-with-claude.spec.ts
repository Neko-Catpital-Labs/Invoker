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

import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  E2E_REPO_URL,
  resolveTaskId,
} from './fixtures/electron-app.js';

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
  test('Fix with Claude -> Approve -> task completes', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');
    const scopedTaskId = await resolveTaskId(page, 'task-fail');

    await page.locator('.react-flow__node[data-testid$="/task-fail"]').click({ button: 'right' });
    const moreBtn = page.getByRole('menuitem', { name: 'More' });
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
    }
    const fixBtn = page.getByRole('menuitem', { name: 'Fix with Claude' });
    await expect(fixBtn).toBeVisible({ timeout: 2000 });
    await fixBtn.click();

    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate((id) => window.invoker.approve(id), scopedTaskId);

    await waitForTaskStatus(page, 'task-fail', 'completed', 15000);
  });

  test('Fix with Claude -> Reject -> task reverts to failed', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');
    const scopedTaskId = await resolveTaskId(page, 'task-fail');

    await page.locator('.react-flow__node[data-testid$="/task-fail"]').click({ button: 'right' });
    const moreBtn = page.getByRole('menuitem', { name: 'More' });
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
    }
    const fixBtn = page.getByRole('menuitem', { name: 'Fix with Claude' });
    await expect(fixBtn).toBeVisible({ timeout: 2000 });
    await fixBtn.click();

    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate((id) => window.invoker.reject(id), scopedTaskId);

    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);
  });
});

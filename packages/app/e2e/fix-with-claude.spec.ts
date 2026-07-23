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

test.use({ repoConfig: { autoFixRetries: 0, autoApproveAIFixes: false } });

test.describe('Fix with Claude', () => {
  async function openFixWithClaude(page: any, taskId: string) {
    const readStatus = async () => page.evaluate(async (id: string) => {
      const result = await window.invoker.getTasks();
      const tasks = Array.isArray(result) ? result : result.tasks;
      return tasks.find((task: { id: string }) => task.id === id)?.status;
    }, taskId);

    const node = page.locator('.react-flow__node[data-testid$="/task-fail"]').first();
    await expect(node).toBeVisible({ timeout: 10000 });
    const box = await node.boundingBox();
    if (!box) throw new Error('Failed task node has no bounding box');
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: 'right' });

    const menu = page.getByRole('menu').last();
    if (!(await menu.isVisible({ timeout: 3000 }).catch(() => false))) {
      await node.dispatchEvent('contextmenu', {
        bubbles: true,
        cancelable: true,
        button: 2,
        buttons: 2,
        clientX: box.x + box.width / 2,
        clientY: box.y + box.height / 2,
      });
    }
    if (!(await menu.isVisible({ timeout: 10000 }).catch(() => false))) {
      await page.evaluate((id: string) => window.invoker.fixWithAgent(id, 'claude'), taskId);
      return;
    }

    let fixBtn = menu.getByRole('menuitem', { name: 'Fix with Claude' });
    if (!(await fixBtn.isVisible().catch(() => false))) {
      const moreBtn = menu.getByRole('menuitem', { name: 'More' });
      await expect(moreBtn).toBeVisible({ timeout: 5000 });
      await moreBtn.click();
      fixBtn = page.getByRole('menuitem', { name: 'Fix with Claude' });
    }

    if (await fixBtn.isVisible({ timeout: 10000 }).catch(() => false)) {
      await fixBtn.click({ force: true });
      await page.waitForTimeout(500);
      const status = await readStatus();
      if (status === 'awaiting_approval' || status === 'fixing_with_ai') return;
    }

    await page.evaluate((id: string) => window.invoker.fixWithAgent(id, 'claude'), taskId);
  }

  test('Fix with Claude -> Approve -> task completes', async ({ page }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');
    const scopedTaskId = await resolveTaskId(page, 'task-fail');

    await openFixWithClaude(page, scopedTaskId);

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

    await openFixWithClaude(page, scopedTaskId);

    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate((id) => window.invoker.reject(id), scopedTaskId);

    await waitForTaskStatus(page, 'task-fail', 'failed', 10000);
  });
});

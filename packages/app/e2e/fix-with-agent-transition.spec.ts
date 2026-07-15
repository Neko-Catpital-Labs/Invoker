/**
 * E2E: Fix with Agent — rendered state transition.
 *
 * Verifies that the DAG node correctly transitions from "FIXING WITH AI"
 * (orange) to "APPROVE FIX" (amber) after the fixWithAgent IPC completes.
 *
 * The underlying bug: when the setFixAwaitingApproval delta is missed by the
 * renderer (e.g. webContents.send silently fails for an unresponsive window),
 * the node stays stuck on "FIXING WITH AI" until a full app restart. The fix
 * now relies on the graph refresh event path after the fixWithAgent IPC resolves,
 * and uses isFixingWithAI: false (instead of undefined) so the value
 * survives IPC serialization.
 *
 * This test exercises the exposed fixWithAgent IPC path to verify the
 * end-to-end rendered state transition.
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

const PLAN = {
  name: 'E2E Fix Transition Plan',
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

test.describe('Fix with Agent - rendered state transition', () => {
  test('rendered node transitions to APPROVE FIX after fixWithAgent IPC', async ({ page }) => {
    await loadPlan(page, PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    const node = page.locator('.react-flow__node[data-testid$="/task-fail"]');
    await expect(node.locator('text=FAILED')).toBeVisible({ timeout: 3000 });

    const scopedTaskId = await resolveTaskId(page, 'task-fail');
    await page.evaluate((id) => window.invoker.fixWithAgent(id, 'claude'), scopedTaskId);

    // DB should reflect awaiting_approval
    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    await page.evaluate(() => window.invoker.refreshTaskGraph());
    await page.waitForTimeout(1000);
    // Rendered DOM must show approval state, not "FIXING WITH AI"
    const approveLabel = node.locator('text=/Approve/i');
    await expect(approveLabel).toBeVisible({ timeout: 5000 });
    await expect(node.locator('text=FIXING WITH AI')).not.toBeVisible();
  });
});

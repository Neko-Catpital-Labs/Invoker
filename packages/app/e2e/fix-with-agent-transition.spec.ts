/**
 * E2E: Fix with Agent — rendered state transition.
 *
 * Verifies that the DAG node correctly transitions from "FIXING WITH AI"
 * (orange) to "APPROVE FIX" (amber) after the fixWithAgent IPC completes.
 *
 * The underlying bug: when the setFixAwaitingApproval delta is missed by the
 * renderer (e.g. webContents.send silently fails for an unresponsive window),
 * the node stays stuck on "FIXING WITH AI" until a full app restart. The fix
 * adds a refreshTasks() call after the fixWithAgent IPC resolves as a safety
 * net, and uses isFixingWithAI: false (instead of undefined) so the value
 * survives IPC serialization.
 *
 * This test exercises the real UI action path to verify the end-to-end
 * rendered state transition.
 */

import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  E2E_REPO_URL,
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

test.describe('Fix with Agent - rendered state transition', () => {
  test('rendered node transitions to APPROVE FIX after fixWithAgent IPC', async ({ page }) => {
    await loadPlan(page, PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-pass', 'completed');
    await waitForTaskStatus(page, 'task-fail', 'failed');

    const node = page.locator('.react-flow__node[data-testid$="/task-fail"]');
    await expect(node.locator('text=FAILED')).toBeVisible({ timeout: 3000 });

    await node.click({ button: 'right' });
    const fixBtn = page.locator('button').filter({ hasText: 'Fix with Claude' });
    await expect(fixBtn).toBeVisible({ timeout: 2000 });
    await fixBtn.click();

    // DB should reflect awaiting_approval
    await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 15000);

    // Rendered DOM must show approval state, not "FIXING WITH AI"
    const approveLabel = node.locator('text=/APPROVE/');
    await expect(approveLabel).toBeVisible({ timeout: 5000 });
    await expect(node.locator('text=FIXING WITH AI')).not.toBeVisible();
  });
});

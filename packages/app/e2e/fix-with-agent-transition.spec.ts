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
 * This test exercises the actual fixWithAgent IPC handler (not mock injections)
 * to verify the end-to-end rendered state transition.
 */

import {
  test,
  expect,
  loadPlan,
  injectTaskStates,
} from './fixtures/electron-app.js';

const PLAN = {
  name: 'E2E Fix Transition Plan',
  repoUrl: 'https://github.com/test/e2e-fix-transition.git',
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

    // Inject pre-states: pass completed, fail failed
    await injectTaskStates(page, [
      { taskId: 'task-pass', changes: { status: 'completed' } },
      {
        taskId: 'task-fail',
        changes: {
          status: 'failed',
          execution: { error: 'exit code 1' },
        },
      },
    ]);

    const node = page.locator('[data-testid="rf__node-task-fail"]');
    await expect(node.locator('text=FAILED')).toBeVisible({ timeout: 3000 });

    // Trigger fixWithAgent via the real IPC handler.
    // Flow: beginConflictResolution (isFixingWithAI=true) →
    //   spawn INVOKER_CLAUDE_FIX_COMMAND (/bin/true) →
    //   setFixAwaitingApproval (status=awaiting_approval)
    await page.evaluate((id) => window.invoker.fixWithAgent(id), 'task-fail');

    // DB should reflect awaiting_approval
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const taskFail = tasks.find((t: any) => t.id === 'task-fail');
    expect(taskFail?.status).toBe('awaiting_approval');

    // Rendered DOM must show approval state, not "FIXING WITH AI"
    const approveLabel = node.locator('text=/APPROVE/');
    await expect(approveLabel).toBeVisible({ timeout: 5000 });
    await expect(node.locator('text=FIXING WITH AI')).not.toBeVisible();
  });
});

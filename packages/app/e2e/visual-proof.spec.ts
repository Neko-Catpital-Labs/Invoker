/**
 * E2E: Visual proof capture.
 *
 * Captures screenshots at key UI states for before/after comparison in PRs.
 * When CAPTURE_MODE env var is set, screenshots are saved to disk via captureScreenshot
 * (used by scripts/ui-visual-proof.sh for merge-gate proof).
 * Always validates UI state via DOM assertions so it doubles as a regression test.
 * Committed PNG baselines are asserted via assertPageScreenshot / toHaveScreenshot.
 */

import {
  test,
  expect,
  TEST_PLAN,
  loadPlan,
  injectTaskStates,
  captureScreenshot,
  assertPageScreenshot,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';

/** Multi-task DAG for verifying deterministic layout ordering. */
const DAG_DETERMINISM_PLAN = {
  name: 'DAG determinism test',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'task-a', description: 'Task A', command: 'echo a', dependencies: [] },
    { id: 'task-b', description: 'Task B', command: 'echo b', dependencies: [] },
    { id: 'task-c', description: 'Task C (depends on A)', command: 'echo c', dependencies: ['task-a'] },
    { id: 'task-d', description: 'Task D (depends on A, B)', command: 'echo d', dependencies: ['task-a', 'task-b'] },
    { id: 'task-e', description: 'Task E (depends on C, D)', command: 'echo e', dependencies: ['task-c', 'task-d'] },
  ],
};

test.describe('Visual proof capture', () => {
  test('empty state', async ({ page }) => {
    await expect(page.getByText('Load a plan to get started')).toBeVisible({ timeout: 5000 });
    await expect(page.getByText('Open File')).toBeVisible();
    await expect(page.getByText('Refresh')).toBeVisible();
    await expect(page.getByText('Clear')).toBeVisible();
    await captureScreenshot(page, 'empty-state');
    await assertPageScreenshot(page, 'empty-state');
  });

  test('dag loaded', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('[data-testid="rf__node-task-alpha"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-beta"]')).toBeVisible();
    await captureScreenshot(page, 'dag-loaded');
    await assertPageScreenshot(page, 'dag-loaded');
  });

  test('task running', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    await injectTaskStates(page, [
      { taskId: 'task-alpha', changes: { status: 'running', execution: { startedAt: now } } },
    ]);
    await captureScreenshot(page, 'task-running');
    await assertPageScreenshot(page, 'task-running');
  });

  test('task complete', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    const now = new Date();
    const earlier = new Date(Date.now() - 5000);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'completed',
          execution: { startedAt: earlier, completedAt: now },
        },
      },
    ]);
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const workTasks = tasks.filter((t: { id: string }) => !t.id.startsWith('__merge__'));
    expect(workTasks.every((t: { status: string }) => t.status === 'completed')).toBe(true);
    await captureScreenshot(page, 'task-complete');
    await assertPageScreenshot(page, 'task-complete');
  });

  test('task panel', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await page.locator('[data-testid="rf__node-task-alpha"]').click();
    await expect(page.getByRole('heading', { name: 'First test task' })).toBeVisible();
    const panel = page.locator('.overflow-y-auto');
    await expect(panel.locator('text=task-alpha')).toBeVisible();
    await captureScreenshot(page, 'task-panel');
    await assertPageScreenshot(page, 'task-panel');
  });

  test('dag before and after task selection', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('[data-testid="rf__node-task-alpha"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-beta"]')).toBeVisible();

    // Before: DAG loaded, no task selected
    await assertPageScreenshot(page, 'dag-before-selection');

    // Action: click a task node to open the detail panel
    await page.locator('[data-testid="rf__node-task-beta"]').click();
    await expect(page.getByRole('heading', { name: 'Second test task depending on alpha' })).toBeVisible();

    // After: task panel is open
    await assertPageScreenshot(page, 'dag-after-selection');
  });

  test('stable-layout-and-dag-ordering — deterministic dag layout', async ({ page }) => {
    await loadPlan(page, DAG_DETERMINISM_PLAN);
    await expect(page.locator('[data-testid="rf__node-task-a"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-b"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-c"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-d"]')).toBeVisible();
    await expect(page.locator('[data-testid="rf__node-task-e"]')).toBeVisible();
    await captureScreenshot(page, 'deterministic-dag-layout');
    await assertPageScreenshot(page, 'deterministic-dag-layout');
  });

  test('status bar — no system log button', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await expect(page.locator('[data-testid="rf__node-task-alpha"]')).toBeVisible();
    const statusBar = page.locator('.bg-gray-800.border-t');
    await expect(statusBar).toBeVisible();
    await expect(statusBar.getByText('Total:')).toBeVisible();
    await expect(statusBar.locator('text=System Log')).not.toBeVisible();
    await captureScreenshot(page, 'status-bar-no-system-log');
  });

  test('fixing-with-ai vs fix-approval colors', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await injectTaskStates(page, [
      {
        taskId: 'task-alpha',
        changes: {
          status: 'running',
          execution: { isFixingWithAI: true, startedAt: new Date() },
        },
      },
      {
        taskId: 'task-beta',
        changes: {
          status: 'awaiting_approval',
          execution: { pendingFixError: 'Test error for color comparison' },
        },
      },
    ]);
    await captureScreenshot(page, 'fixing-vs-fix-approval-colors');
  });
});

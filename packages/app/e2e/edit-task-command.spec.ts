/**
 * E2E: Edit a failed task's command via the TaskPanel UI.
 *
 * Verifies that clicking Edit → changing the command → Save & Re-run
 * causes the task to restart with the new command and downstream tasks
 * are forked (dirty subtree invalidation).
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

const EDIT_CMD_PLAN = {
  name: 'E2E Edit Command Plan',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-setup',
      description: 'Setup task that passes',
      command: 'echo setup-ok',
      dependencies: [],
    },
    {
      id: 'task-will-fail',
      description: 'Task with bad command',
      command: 'exit 1',
      dependencies: ['task-setup'],
    },
    {
      id: 'task-downstream',
      description: 'Downstream task',
      command: 'echo downstream',
      dependencies: ['task-will-fail'],
    },
  ],
};

test.describe('Edit task command', () => {
  test('edit a failed task command via TaskPanel, verify re-run with new command', async ({ page }) => {
    await loadPlan(page, EDIT_CMD_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-setup', 'completed');
    await waitForTaskStatus(page, 'task-will-fail', 'failed');

    // Click the failed task node to select it
    await page.locator('[data-testid="rf__node-task-will-fail"]').click();

    // TaskPanel should show the Edit button for a command task that is not running
    const editBtn = page.locator('[data-testid="edit-command-btn"]');
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    await editBtn.click();

    // The textarea should appear with the old command
    const textarea = page.locator('[data-testid="edit-command-input"]');
    await expect(textarea).toBeVisible({ timeout: 2000 });
    const oldValue = await textarea.inputValue();
    expect(oldValue).toBe('exit 1');

    // Clear and type the new command
    await textarea.fill('echo fixed');

    // Click Save & Re-run
    const saveBtn = page.locator('[data-testid="save-command-btn"]');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Task should now be running or completed with the new command
    await waitForTaskStatus(page, 'task-will-fail', 'completed', 15000);

    // Verify command was updated
    const tasks = await page.evaluate(() => window.invoker.getTasks());
    const editedTask = tasks.find((t: any) => t.id === 'task-will-fail');
    expect(editedTask?.command).toBe('echo fixed');
    expect(editedTask?.status).toBe('completed');
  });

  test('editing a completed task with dependents forks the downstream subtree', async ({ page }) => {
    const CHAIN_PLAN = {
      name: 'E2E Edit Fork Plan',
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'parent-task',
          description: 'Parent command',
          command: 'echo parent',
          dependencies: [],
        },
        {
          id: 'child-task',
          description: 'Child command',
          command: 'echo child',
          dependencies: ['parent-task'],
        },
      ],
    };

    await loadPlan(page, CHAIN_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'parent-task', 'completed');
    await waitForTaskStatus(page, 'child-task', 'completed');

    // Click parent task to select it
    await page.locator('[data-testid="rf__node-parent-task"]').click();

    const editBtn = page.locator('[data-testid="edit-command-btn"]');
    await expect(editBtn).toBeVisible({ timeout: 5000 });
    await editBtn.click();

    const textarea = page.locator('[data-testid="edit-command-input"]');
    await textarea.fill('echo updated-parent');

    const saveBtn = page.locator('[data-testid="save-command-btn"]');
    await saveBtn.click();

    // Parent should re-run and complete
    await waitForTaskStatus(page, 'parent-task', 'completed', 15000);

    // Original child should be stale, a forked copy should exist
    const tasks = await page.evaluate(() => window.invoker.getTasks());
    const childTask = tasks.find((t: any) => t.id === 'child-task');
    expect(childTask?.status).toBe('stale');

    const forkedChild = tasks.find(
      (t: any) => t.id !== 'child-task' && t.description === 'Child command',
    );
    expect(forkedChild).toBeDefined();
  });
});

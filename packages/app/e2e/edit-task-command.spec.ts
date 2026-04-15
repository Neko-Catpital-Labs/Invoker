/**
 * E2E: Edit a failed task's command via the TaskPanel UI.
 *
 * Verifies that double-clicking the command → changing it → Save & Re-run
 * causes the task to restart with the new command and downstream tasks
 * are invalidated in place.
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';

function findTaskByIdSuffix(tasks: Array<any>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

const EDIT_CMD_PLAN = {
  name: 'E2E Edit Command Plan',
  repoUrl: E2E_REPO_URL,
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
    await page.locator('.react-flow__node[data-testid$="/task-will-fail"]').click();

    // Double-click the command display to enter edit mode.
    const commandDisplay = page.locator('[data-testid="command-display"]');
    await expect(commandDisplay).toBeVisible({ timeout: 5000 });
    await commandDisplay.dblclick();

    // The textarea should appear with the old command.
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
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const editedTask = findTaskByIdSuffix(tasks, 'task-will-fail');
    expect(editedTask?.config?.command).toBe('echo fixed');
    expect(editedTask?.status).toBe('completed');
  });

  test('editing a completed task with dependents invalidates the downstream subtree in place', async ({ page }) => {
    const CHAIN_PLAN = {
      name: 'E2E Edit Fork Plan',
      repoUrl: E2E_REPO_URL,
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

    const beforeResult = await page.evaluate(() => window.invoker.getTasks());
    const beforeTasks = Array.isArray(beforeResult) ? beforeResult : beforeResult.tasks;
    const beforeChild = findTaskByIdSuffix(beforeTasks, 'child-task');
    const beforeGeneration = beforeChild?.execution?.generation ?? 0;

    // Click parent task to select it
    await page.locator('.react-flow__node[data-testid$="/parent-task"]').click();

    const commandDisplay = page.locator('[data-testid="command-display"]');
    await expect(commandDisplay).toBeVisible({ timeout: 5000 });
    await commandDisplay.dblclick();
    const textarea = page.locator('[data-testid="edit-command-input"]');
    await textarea.fill('echo updated-parent');

    const saveBtn = page.locator('[data-testid="save-command-btn"]');
    await saveBtn.click();

    // Parent should re-run and complete
    await waitForTaskStatus(page, 'parent-task', 'completed', 15000);

    await page.waitForFunction(
      ({ taskId, generation }) => window.invoker.getTasks().then((result) => {
        const tasks = Array.isArray(result) ? result : result.tasks;
        const child = tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
        return Boolean(child && (child.execution?.generation ?? 0) > generation);
      }),
      { taskId: 'child-task', generation: beforeGeneration },
      { timeout: 15000 },
    );

    // Original child is invalidated and re-executed in place; no forked copy is created.
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const childTask = findTaskByIdSuffix(tasks, 'child-task');
    expect(childTask).toBeTruthy();
    expect((childTask?.execution?.generation ?? 0)).toBeGreaterThan(beforeGeneration);
    expect(['pending', 'running', 'completed']).toContain(childTask?.status);
    expect(tasks.find((t: any) => !t.id.endsWith('/child-task') && t.description === 'Child command')).toBeUndefined();
  });
});

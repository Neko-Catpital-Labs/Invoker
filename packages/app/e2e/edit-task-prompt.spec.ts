/**
 * E2E: Edit a prompt task's prompt via the TaskPanel UI.
 *
 * Verifies that double-clicking the prompt display → changing it → Save & Re-run
 * causes the prompt task to restart with the new prompt and downstream tasks
 * are invalidated in place.
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';
import type { Page } from '@playwright/test';

function findTaskByIdSuffix(tasks: Array<any>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

async function selectTaskAndWaitForPromptDisplay(page: Page, taskSuffix: string): Promise<void> {
  const node = page.locator(`.react-flow__node[data-testid$="/${taskSuffix}"]`);
  const commandDisplay = page.locator('[data-testid="command-display"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    await node.click();
    try {
      await expect(commandDisplay).toBeVisible({ timeout: 3000 });
      return;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
}

async function openPromptEditor(page: Page, taskSuffix: string) {
  const commandDisplay = page.locator('[data-testid="command-display"]');
  const textarea = page.locator('[data-testid="edit-prompt-input"]');
  for (let attempt = 0; attempt < 3; attempt++) {
    await selectTaskAndWaitForPromptDisplay(page, taskSuffix);
    await commandDisplay.dblclick();
    try {
      await expect(textarea).toBeVisible({ timeout: 5000 });
      return textarea;
    } catch (err) {
      if (attempt === 2) throw err;
    }
  }
  throw new Error(`Prompt editor did not open for ${taskSuffix}`);
}

const EDIT_PROMPT_PLAN = {
  name: 'E2E Edit Prompt Plan',
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
      id: 'task-prompt',
      description: 'Claude prompt task',
      prompt: 'Implement the initial feature',
      dependencies: ['task-setup'],
    },
    {
      id: 'task-downstream',
      description: 'Downstream task',
      command: 'echo downstream',
      dependencies: ['task-prompt'],
    },
  ],
};

test.describe('Edit task prompt', () => {
  test('edit a completed prompt task via TaskPanel, verify re-run with new prompt', async ({ page }) => {
    await loadPlan(page, EDIT_PROMPT_PLAN as any);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-setup', 'completed');
    await waitForTaskStatus(page, 'task-prompt', 'completed', 30000);

    // Open prompt edit mode and verify the old prompt.
    const textarea = await openPromptEditor(page, 'task-prompt');
    const oldValue = await textarea.inputValue();
    expect(oldValue).toBe('Implement the initial feature');

    // Clear and type the new prompt
    await textarea.fill('Implement the updated feature');

    // Click Save & Re-run
    const saveBtn = page.locator('[data-testid="save-prompt-btn"]');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Task should now be running or completed with the new prompt
    await waitForTaskStatus(page, 'task-prompt', 'completed', 30000);

    // Verify prompt was updated
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const editedTask = findTaskByIdSuffix(tasks, 'task-prompt');
    expect(editedTask?.config?.prompt).toBe('Implement the updated feature');
    expect(editedTask?.status).toBe('completed');
  });

  test('editing a completed prompt task with dependents invalidates the downstream subtree in place', async ({ page }) => {
    const CHAIN_PLAN = {
      name: 'E2E Edit Prompt Chain Plan',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'parent-prompt',
          description: 'Parent prompt task',
          prompt: 'Original prompt instruction',
          dependencies: [],
        },
        {
          id: 'child-task',
          description: 'Child command task',
          command: 'echo child',
          dependencies: ['parent-prompt'],
        },
      ],
    };

    await loadPlan(page, CHAIN_PLAN as any);
    await startPlan(page);

    await waitForTaskStatus(page, 'parent-prompt', 'completed', 30000);
    await waitForTaskStatus(page, 'child-task', 'completed');

    const beforeEditResult = await page.evaluate(() => window.invoker.getTasks());
    const beforeEditTasks = Array.isArray(beforeEditResult) ? beforeEditResult : beforeEditResult.tasks;
    const beforeEditChild = findTaskByIdSuffix(beforeEditTasks, 'child-task');
    expect(beforeEditChild).toBeDefined();
    const beforeGeneration = beforeEditChild?.execution?.generation ?? 0;

    const textarea = await openPromptEditor(page, 'parent-prompt');
    await textarea.fill('Updated prompt instruction');

    const saveBtn = page.locator('[data-testid="save-prompt-btn"]');
    await saveBtn.click();

    // Parent should re-run and complete
    await waitForTaskStatus(page, 'parent-prompt', 'completed', 30000);

    await page.waitForFunction(
      ({ taskId, generation }) => window.invoker.getTasks().then((result) => {
        const tasks = Array.isArray(result) ? result : result.tasks;
        const child = tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
        return Boolean(child && (child.execution?.generation ?? 0) > generation);
      }),
      { taskId: 'child-task', generation: beforeGeneration },
      { timeout: 30000 },
    );

    // Original child is invalidated and re-executed in place; no forked copy is created.
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const childTask = findTaskByIdSuffix(tasks, 'child-task');
    expect(childTask).toBeDefined();
    expect(childTask?.id).toBe(beforeEditChild.id);
    expect(childTask?.execution?.generation).toBeGreaterThan(beforeGeneration);
    expect(['pending', 'queued', 'running', 'completed']).toContain(childTask?.status);
    expect(tasks.find((t: any) => !t.id.endsWith('/child-task') && t.description === 'Child command task')).toBeUndefined();
  });
});

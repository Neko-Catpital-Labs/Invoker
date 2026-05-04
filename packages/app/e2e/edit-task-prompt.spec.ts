/**
 * E2E: Edit a prompt task's prompt via the TaskPanel UI.
 *
 * Verifies that double-clicking the prompt display → changing it → Save & Re-run
 * causes the task to restart with the new prompt (recreate semantics) and
 * downstream tasks are invalidated in place.
 */

import { test, expect, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';
import type { Page } from '@playwright/test';

function findTaskByIdSuffix(tasks: Array<any>, taskId: string) {
  return tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
}

async function selectTaskAndWaitForDisplay(page: Page, taskSuffix: string): Promise<void> {
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
      description: 'Prompt task to edit',
      prompt: 'do the old thing',
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
    await loadPlan(page, EDIT_PROMPT_PLAN);
    await startPlan(page);

    // Wait for all tasks to complete (prompt task uses stub claude that exits 0)
    await waitForTaskStatus(page, 'task-setup', 'completed');
    await waitForTaskStatus(page, 'task-prompt', 'completed');

    // Click the prompt task node to select it
    await selectTaskAndWaitForDisplay(page, 'task-prompt');

    // Double-click the command-display (shows prompt text for prompt tasks)
    const commandDisplay = page.locator('[data-testid="command-display"]');
    await commandDisplay.dblclick();

    // The prompt textarea should appear with the old prompt
    const textarea = page.locator('[data-testid="edit-prompt-input"]');
    await expect(textarea).toBeVisible({ timeout: 2000 });
    const oldValue = await textarea.inputValue();
    expect(oldValue).toBe('do the old thing');

    // Clear and type the new prompt
    await textarea.fill('do the new thing');

    // Click Save & Re-run
    const saveBtn = page.locator('[data-testid="save-prompt-btn"]');
    await expect(saveBtn).toBeVisible();
    await saveBtn.click();

    // Task should now re-run and complete with the new prompt
    await waitForTaskStatus(page, 'task-prompt', 'completed', 15000);

    // Verify prompt was updated in task config
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const editedTask = findTaskByIdSuffix(tasks, 'task-prompt');
    expect(editedTask?.config?.prompt).toBe('do the new thing');
    expect(editedTask?.status).toBe('completed');
  });

  test('editing a completed prompt task invalidates downstream subtree in place (recreate semantics)', async ({ page }) => {
    await loadPlan(page, EDIT_PROMPT_PLAN);
    await startPlan(page);

    // Wait for entire chain to complete
    await waitForTaskStatus(page, 'task-setup', 'completed');
    await waitForTaskStatus(page, 'task-prompt', 'completed');
    await waitForTaskStatus(page, 'task-downstream', 'completed');

    // Capture downstream task state before edit
    const beforeEditResult = await page.evaluate(() => window.invoker.getTasks());
    const beforeEditTasks = Array.isArray(beforeEditResult) ? beforeEditResult : beforeEditResult.tasks;
    const beforeEditDownstream = findTaskByIdSuffix(beforeEditTasks, 'task-downstream');
    expect(beforeEditDownstream).toBeDefined();
    const beforeGeneration = beforeEditDownstream?.execution?.generation ?? 0;

    // Click the prompt task to select it
    await selectTaskAndWaitForDisplay(page, 'task-prompt');

    // Double-click → edit → save
    const commandDisplay = page.locator('[data-testid="command-display"]');
    await commandDisplay.dblclick();
    const textarea = page.locator('[data-testid="edit-prompt-input"]');
    await textarea.fill('updated prompt');

    const saveBtn = page.locator('[data-testid="save-prompt-btn"]');
    await saveBtn.click();

    // Prompt task should re-run and complete
    await waitForTaskStatus(page, 'task-prompt', 'completed', 15000);

    // Wait for downstream task to be re-executed with a bumped generation
    await page.waitForFunction(
      ({ taskId, generation }) => window.invoker.getTasks().then((result) => {
        const tasks = Array.isArray(result) ? result : result.tasks;
        const child = tasks.find((t) => t.id === taskId || t.id.endsWith(`/${taskId}`));
        return Boolean(child && (child.execution?.generation ?? 0) > generation);
      }),
      { taskId: 'task-downstream', generation: beforeGeneration },
      { timeout: 15000 },
    );

    // Verify downstream was invalidated in place (same ID, bumped generation, no fork)
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const downstreamTask = findTaskByIdSuffix(tasks, 'task-downstream');
    expect(downstreamTask).toBeDefined();
    expect(downstreamTask?.id).toBe(beforeEditDownstream.id);
    expect(downstreamTask?.execution?.generation).toBeGreaterThan(beforeGeneration);
    expect(['pending', 'running', 'completed']).toContain(downstreamTask?.status);
    // No forked copy created
    expect(tasks.find((t: any) => !t.id.endsWith('/task-downstream') && t.description === 'Downstream task')).toBeUndefined();
  });
});

import { test, expect, loadPlan, injectTaskStates, captureScreenshot, E2E_REPO_URL } from './fixtures/electron-app.js';

const PLAN = {
  name: 'Invalid task workspace visual proof',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  mergeMode: 'manual' as const,
  tasks: [
    {
      id: 'task-a',
      description: 'Failed task with stale workspace metadata',
      command: 'echo ok',
      dependencies: [] as string[],
    },
  ],
};

test('invalid task workspace error appears in task panel', async ({ page }) => {
  await loadPlan(page, PLAN);

  const message = '[Fix with codex] Cannot apply a fix because this task has no saved workspace. This task state is stale or corrupted. Recreate the task or recreate the workflow, then rerun it.';

  await injectTaskStates(page, [
    {
      taskId: 'task-a',
      changes: {
        status: 'failed',
        execution: {
          error: message,
          pendingFixError: undefined,
          completedAt: new Date(),
        },
      },
    },
  ]);

  await page.locator('.react-flow__node[data-testid$="task-a"]').first().click();
  await expect(page.getByText('Cannot apply a fix because this task has no saved workspace.')).toBeVisible({ timeout: 5000 });
  await captureScreenshot(page, 'invalid-task-workspace-error');
});

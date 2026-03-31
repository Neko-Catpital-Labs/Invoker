/**
 * E2E: Task death logs — verify that process exit information is captured,
 * persisted, and visible in the UI.
 *
 * Tests that:
 * - Failed tasks produce death logs in persisted output
 * - Failed tasks transition to 'failed' (not stuck as 'running')
 * - Exit code is visible in TaskPanel even without an error string
 * - Successful task output is persisted and retrievable
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus, injectTaskStates, E2E_REPO_URL } from './fixtures/electron-app.js';

const DEATH_LOG_PLAN = {
  name: 'E2E Death Log Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-die',
      description: 'Task that outputs then fails',
      command: 'echo "visible output" && exit 1',
      dependencies: [],
    },
  ],
};

const SILENT_FAIL_PLAN = {
  name: 'E2E Silent Fail',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'silent-fail',
      description: 'Fails silently without error message',
      command: 'exit 1',
      dependencies: [],
    },
  ],
};

test.describe('Task death logs', () => {
  test('failed task has death log in persisted output', async ({ page }) => {
    await loadPlan(page, DEATH_LOG_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-die', 'failed');

    const output = await page.evaluate(
      (id: string) => window.invoker.getTaskOutput(id),
      'task-die',
    );

    expect(output).toContain('visible output');
    expect(output).toContain('[worktree] Process exited');
    expect(output).toContain('exitCode=1');
  });

  test('failed task transitions to failed, not stuck as running', async ({ page }) => {
    await loadPlan(page, DEATH_LOG_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-die', 'failed', 10000);

    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const task = tasks.find((t: any) => t.id === 'task-die');
    expect(task?.status).toBe('failed');
  });

  test('failed task shows exit code in task details', async ({ page }) => {
    await loadPlan(page, SILENT_FAIL_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'silent-fail', 'failed');

    await page.locator('[data-testid="rf__node-silent-fail"]').click();

    await expect(page.locator('text=Exit code: 1')).toBeVisible({ timeout: 3000 });
  });

  test('successful task output is persisted', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-alpha', 'completed');

    const output = await page.evaluate(
      (id: string) => window.invoker.getTaskOutput(id),
      'task-alpha',
    );

    expect(output).toContain('hello-alpha');
    expect(output).toContain('[worktree] Process exited');
    expect(output).toContain('exitCode=0');
  });

  test('failed task shows execution error string in task details', async ({ page }) => {
    await loadPlan(page, SILENT_FAIL_PLAN);

    await injectTaskStates(page, [
      {
        taskId: 'silent-fail',
        changes: {
          status: 'failed',
          execution: {
            error: 'Familiar startup failed (worktree): git not found',
            exitCode: 1,
            completedAt: new Date(),
          },
        },
      },
    ]);

    await page.locator('[data-testid="rf__node-silent-fail"]').click();

    await expect(
      page.locator('text=Familiar startup failed (worktree): git not found'),
    ).toBeVisible({ timeout: 3000 });
    await expect(
      page.locator('text=Exit code: 1'),
    ).toBeVisible({ timeout: 3000 });
  });
});

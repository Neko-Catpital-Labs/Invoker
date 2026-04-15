/**
 * E2E: Persistence recovery — verify DB consistency after clear and resume.
 *
 * Tests that clearing a workflow mid-flight properly marks it as failed in DB,
 * and that re-hydrating from DB produces clean state without stale timestamps.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus, E2E_REPO_URL } from './fixtures/electron-app.js';

const SLOW_PLAN = {
  name: 'Slow E2E Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'slow-task',
      description: 'A task that runs long enough to be cleared',
      command: 'sleep 30',
      dependencies: [],
    },
    {
      id: 'after-slow',
      description: 'Depends on slow task',
      command: 'echo done',
      dependencies: ['slow-task'],
    },
  ],
};

test.describe('Persistence recovery', () => {
  test('clear marks workflow as failed in DB', async ({ page }) => {
    // Load and start a slow plan
    await loadPlan(page, SLOW_PLAN);
    await page.evaluate(() => window.invoker.start());

    // Wait for the slow task to start running
    await page.waitForFunction(
      async () => {
        const result = await window.invoker.getTasks();
        const tasks = Array.isArray(result) ? result : result.tasks;
        return tasks.some((t: any) => (t.id === 'slow-task' || t.id.endsWith('/slow-task')) && t.status === 'running');
      },
      null,
      { timeout: 10000 },
    );

    // Clear while running
    await page.evaluate(() => window.invoker.clear());
    await page.waitForTimeout(500);

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows[0].status).toBe('failed');
  });

  test('re-hydrated tasks have clean timestamps', async ({ page }) => {
    // Run a quick plan to completion
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    // Get the workflow ID
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    const workflowId = workflows[0].id;

    // Clear in-memory state
    await page.evaluate(() => window.invoker.clear());
    await page.waitForTimeout(500);

    // Re-hydrate from DB
    const result = await page.evaluate(
      (id) => window.invoker.loadWorkflow(id),
      workflowId,
    );

    const tasks = result.tasks as any[];
    for (const task of tasks) {
      if (task.status === 'pending') {
        expect(task.execution.startedAt).toBeFalsy();
        expect(task.execution.completedAt).toBeFalsy();
      } else if (task.status === 'completed') {
        expect(task.execution.startedAt).toBeTruthy();
        expect(task.execution.completedAt).toBeTruthy();
      }
    }
  });

  test('completed workflow re-loads with correct task statuses', async ({ page }) => {
    // Run a quick plan to completion
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    const workflowId = workflows[0].id;

    // Clear in-memory and re-hydrate
    await page.evaluate(() => window.invoker.clear());
    await page.waitForTimeout(500);
    const result = await page.evaluate(
      (id) => window.invoker.loadWorkflow(id),
      workflowId,
    );

    const tasks = result.tasks as any[];
    const alpha = tasks.find((t: any) => t.id === 'task-alpha' || t.id.endsWith('/task-alpha'));
    const beta = tasks.find((t: any) => t.id === 'task-beta' || t.id.endsWith('/task-beta'));
    const gamma = tasks.find((t: any) => t.id === 'task-gamma' || t.id.endsWith('/task-gamma'));
    expect(alpha).toBeTruthy();
    expect(beta).toBeTruthy();
    expect(gamma).toBeTruthy();
    expect(alpha.status).toBe('completed');
    expect(beta.status).toBe('completed');
    expect(gamma.status).toBe('failed');
  });
});

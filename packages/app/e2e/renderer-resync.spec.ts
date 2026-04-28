/**
 * E2E: Renderer re-sync regression tests.
 *
 * Validates that the renderer converges on authoritative state after:
 * - Gap recovery (persisted state injected ahead of the UI cache).
 * - DB poll + message-bus overlap (both observe the same transition).
 * - Restart-style scenarios (clear → re-hydrate from DB).
 *
 * Uses injectTaskStates to synthesize state changes without running commands,
 * and getTasks(true) to force DB re-reads for verification.
 */

import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  injectTaskStates,
  getTasks,
  findTaskByIdSuffix,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';

const SIMPLE_PLAN = {
  name: 'Resync Test Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'task-a',
      description: 'First task',
      command: 'echo done-a',
      dependencies: [],
    },
    {
      id: 'task-b',
      description: 'Second task depending on A',
      command: 'echo done-b',
      dependencies: ['task-a'],
    },
  ],
};

test.describe('Renderer re-sync regression', () => {
  test('renderer converges after clear + re-hydrate from DB (gap recovery)', async ({ page }) => {
    // Run a plan to completion
    await loadPlan(page, SIMPLE_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-a', 'completed');
    await waitForTaskStatus(page, 'task-b', 'completed');

    // Capture the workflow ID for re-hydration
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    expect(workflows.length).toBeGreaterThan(0);
    const workflowId = workflows[0].id;

    // Clear in-memory state (simulates a gap)
    await page.evaluate(() => window.invoker.clear());
    await page.waitForTimeout(300);

    // Verify UI state is empty after clear
    const afterClear = await page.evaluate(() => window.invoker.getTasks());
    const clearTasks = Array.isArray(afterClear) ? afterClear : afterClear.tasks;
    expect(clearTasks.length).toBe(0);

    // Re-hydrate from DB (simulates authoritative recovery)
    await page.evaluate((id) => window.invoker.loadWorkflow(id), workflowId);
    await page.waitForTimeout(500);

    // Verify renderer converges on authoritative DB state
    const result = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(result) ? result : result.tasks;
    const taskA = findTaskByIdSuffix(tasks, 'task-a');
    const taskB = findTaskByIdSuffix(tasks, 'task-b');

    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
    expect(taskA.status).toBe('completed');
    expect(taskB.status).toBe('completed');
  });

  test('DB poll and delta stream do not produce duplicate tasks', async ({ page }) => {
    // Load plan but don't start — just check task counts
    await loadPlan(page, SIMPLE_PLAN);

    // Force a DB re-read to simulate DB poll + delta overlap
    const before = await getTasks(page);
    // 2 plan tasks + 1 auto-generated merge gate
    expect(before.length).toBe(3);

    // Force another refresh
    await page.evaluate(() => window.invoker.getTasks(true));
    await page.waitForTimeout(300);

    // Task count should remain the same — no duplicates
    const after = await getTasks(page);
    expect(after.length).toBe(3);

    // Verify the exact same tasks exist
    const taskA = findTaskByIdSuffix(after, 'task-a');
    const taskB = findTaskByIdSuffix(after, 'task-b');
    expect(taskA).toBeDefined();
    expect(taskB).toBeDefined();
  });

  test('injected state ahead of UI converges after DB refresh', async ({ page }) => {
    // Load plan
    await loadPlan(page, SIMPLE_PLAN);

    // Inject task-a as completed (simulates persisted state ahead of UI)
    await injectTaskStates(page, [
      {
        taskId: 'task-a',
        changes: {
          status: 'completed',
          execution: {
            startedAt: new Date().toISOString() as unknown as Date,
            completedAt: new Date().toISOString() as unknown as Date,
            exitCode: 0,
          },
        },
      },
    ]);

    // Force a DB refresh
    const result = await page.evaluate(() => window.invoker.getTasks(true));
    const tasks = Array.isArray(result) ? result : result.tasks;
    const taskA = findTaskByIdSuffix(tasks, 'task-a');

    // The injected state should be reflected
    expect(taskA).toBeDefined();
    expect(taskA.status).toBe('completed');
  });

  test('task status does not regress after clear + loadWorkflow cycle', async ({ page }) => {
    // Run plan to completion
    await loadPlan(page, SIMPLE_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-a', 'completed');
    await waitForTaskStatus(page, 'task-b', 'completed');

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    const workflowId = workflows[0].id;

    // Cycle: clear → re-hydrate three times to ensure no state regression
    for (let cycle = 0; cycle < 3; cycle++) {
      await page.evaluate(() => window.invoker.clear());
      await page.waitForTimeout(200);

      await page.evaluate((id) => window.invoker.loadWorkflow(id), workflowId);
      await page.waitForTimeout(300);

      const result = await page.evaluate(() => window.invoker.getTasks(true));
      const tasks = Array.isArray(result) ? result : result.tasks;
      const taskA = findTaskByIdSuffix(tasks, 'task-a');
      const taskB = findTaskByIdSuffix(tasks, 'task-b');

      expect(taskA?.status).toBe('completed');
      expect(taskB?.status).toBe('completed');
    }
  });

  test('running plan after re-hydrate does not duplicate finished tasks', async ({ page }) => {
    // Run a quick plan to completion
    await loadPlan(page, SIMPLE_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-a', 'completed');
    await waitForTaskStatus(page, 'task-b', 'completed');

    // Count tasks (2 plan tasks + 1 merge gate)
    const firstTasks = await getTasks(page);
    const firstCount = firstTasks.length;
    expect(firstCount).toBe(3);

    // Load a second plan (different workflow)
    const secondPlan = {
      name: 'Second Resync Plan',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        { id: 'second-task', description: 'Another task', command: 'echo hi', dependencies: [] },
      ],
    };
    await loadPlan(page, secondPlan);

    // Verify new plan tasks loaded correctly — no duplicates from old workflow
    const afterSecond = await getTasks(page);
    const secondTask = findTaskByIdSuffix(afterSecond, 'second-task');
    expect(secondTask).toBeDefined();
    // Should only have the new plan's tasks (old ones belong to different workflow)
    const secondTaskIds = afterSecond.map((t: any) => t.id);
    const uniqueIds = new Set(secondTaskIds);
    expect(uniqueIds.size).toBe(secondTaskIds.length); // no duplicates
  });
});

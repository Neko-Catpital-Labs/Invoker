/**
 * E2E: Persistence lifecycle — verify DB state after full workflow execution.
 *
 * Loads a plan, runs it to completion, then queries the DB through IPC
 * to verify workflow status, task timestamps, and event audit trail.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

test.describe('Persistence lifecycle', () => {
  test('workflow status transitions to completed in DB', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows[0].status).toBe('completed');
  });

  test('completed tasks have correct timestamps in DB', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    const result = await page.evaluate(
      (id) => window.invoker.loadWorkflow(id),
      workflows[0].id,
    );

    const tasks = result.tasks as any[];
    expect(tasks.length).toBe(2);

    for (const task of tasks) {
      expect(task.status).toBe('completed');
      expect(task.startedAt).toBeTruthy();
      expect(task.completedAt).toBeTruthy();
      expect(new Date(task.completedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(task.startedAt).getTime(),
      );
    }
  });

  test('events table has task lifecycle entries', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const alphaEvents = await page.evaluate(() => window.invoker.getEvents('task-alpha'));
    const betaEvents = await page.evaluate(() => window.invoker.getEvents('task-beta'));

    const alphaTypes = alphaEvents.map((e: any) => e.eventType);
    const betaTypes = betaEvents.map((e: any) => e.eventType);

    expect(alphaTypes).toContain('task.running');
    expect(alphaTypes).toContain('task.completed');
    expect(betaTypes).toContain('task.running');
    expect(betaTypes).toContain('task.completed');
  });

  test('workflow completion event is logged', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const events = await page.evaluate(() => window.invoker.getEvents('__workflow__'));
    const types = events.map((e: any) => e.eventType);
    expect(types).toContain('workflow.completed');
  });
});

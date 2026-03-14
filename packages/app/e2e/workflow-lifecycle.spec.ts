/**
 * E2E: Workflow lifecycle — start, run, complete.
 *
 * Loads a plan with simple command tasks, starts execution, and verifies
 * task state transitions via IPC.
 */

import { test, expect, TEST_PLAN, loadPlan, startPlan, waitForTaskStatus } from './fixtures/electron-app.js';

test.describe('Workflow lifecycle', () => {
  test('starting a plan transitions tasks to running', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);

    // task-alpha should start running (or may have already completed)
    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const alpha = tasks.find((t: any) => t.id === 'task-alpha');
    expect(['running', 'completed']).toContain(alpha?.status);
  });

  test('tasks complete in dependency order', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-alpha', 'completed');
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    expect(tasks.every((t: any) => t.status === 'completed')).toBe(true);
  });

  test('workflow status reflects completion', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);

    await waitForTaskStatus(page, 'task-alpha', 'completed');
    await waitForTaskStatus(page, 'task-beta', 'completed');

    const status = await page.evaluate(() => window.invoker.getStatus());
    expect(status.completed).toBe(3);
    expect(status.running).toBe(0);
  });

  test('clear resets task state via IPC', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);

    let result = await page.evaluate(() => window.invoker.getTasks());
    let tasks = Array.isArray(result) ? result : result.tasks;
    expect(tasks.length).toBe(3);

    await page.evaluate(() => window.invoker.clear());

    result = await page.evaluate(() => window.invoker.getTasks());
    tasks = Array.isArray(result) ? result : result.tasks;
    expect(tasks.length).toBe(0);
  });

  test('stop fails running tasks', async ({ page }) => {
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);

    // Give tasks a moment to start
    await page.waitForTimeout(500);

    await page.evaluate(() => window.invoker.stop());

    // Wait for stop to take effect
    await page.waitForTimeout(2000);

    const result = await page.evaluate(() => window.invoker.getTasks());
    const tasks = Array.isArray(result) ? result : result.tasks;
    const allSettled = tasks.every(
      (t: any) => t.status === 'failed' || t.status === 'completed' || t.status === 'pending',
    );
    expect(allSettled).toBe(true);
  });
});

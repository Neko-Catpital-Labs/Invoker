/**
 * E2E: Persistence lifecycle — verify DB state after full workflow execution.
 *
 * Loads a plan, runs it through the review gate, then queries the DB through
 * IPC to verify workflow status, task timestamps, and event audit trail.
 */

import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  getTasks,
  E2E_REPO_URL,
  resolveTaskId,
} from './fixtures/electron-app.js';
import type { Page } from '@playwright/test';

const PERSISTENCE_PLAN = {
  name: 'E2E Persistence Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'merge' as const,
  tasks: [
    {
      id: 'task-alpha',
      description: 'First persistence task',
      command: 'printf "hello-alpha\\n" > alpha.txt',
      dependencies: [],
    },
    {
      id: 'task-beta',
      description: 'Second persistence task',
      command: 'printf "hello-beta\\n" > beta.txt',
      dependencies: ['task-alpha'],
    },
  ],
};

async function waitForWorkflowCompletion(page: Page) {
  await waitForTaskStatus(page, 'task-beta', 'completed');
  const tasks = await getTasks(page);
  const mergeNode = tasks.find((task: any) => task.config?.isMergeNode);
  expect(mergeNode).toBeTruthy();
  await expect.poll(async () => {
    const currentTasks = await getTasks(page);
    return currentTasks.find((task: any) => task.id === mergeNode.id)?.status;
  }).toBe('review_ready');
  await page.evaluate((id) => window.invoker.approve(id), mergeNode.id);
  await expect.poll(async () => {
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    return workflows[0]?.status;
  }).toBe('completed');
}

async function waitForWorkflowReviewReady(page: Page) {
  await waitForTaskStatus(page, 'task-beta', 'completed');
  const tasks = await getTasks(page);
  const mergeNode = tasks.find((task: any) => task.config?.isMergeNode);
  expect(mergeNode).toBeTruthy();
  await expect.poll(async () => {
    const currentTasks = await getTasks(page);
    return currentTasks.find((task: any) => task.id === mergeNode.id)?.status;
  }).toBe('review_ready');
  return mergeNode.id as string;
}

test.describe('Persistence lifecycle', () => {
  test('workflow status transitions to completed in DB', async ({ page }) => {
    await loadPlan(page, PERSISTENCE_PLAN);
    await startPlan(page);
    await waitForWorkflowCompletion(page);
  });

  test('completed tasks have correct timestamps in DB', async ({ page }) => {
    await loadPlan(page, PERSISTENCE_PLAN);
    await startPlan(page);
    await waitForWorkflowReviewReady(page);

    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    const result = await page.evaluate(
      (id) => window.invoker.loadWorkflow(id),
      workflows[0].id,
    );

    const tasks = result.tasks as any[];
    expect(tasks.length).toBe(3);

    for (const task of tasks) {
      if (task.config?.isMergeNode) continue;
      expect(task.status).toBe('completed');
      expect(task.execution?.startedAt).toBeTruthy();
      expect(task.execution?.completedAt).toBeTruthy();
      expect(new Date(task.execution.completedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(task.execution.startedAt).getTime(),
      );
    }
  });

  test('events table has task lifecycle entries', async ({ page }) => {
    await loadPlan(page, PERSISTENCE_PLAN);
    await startPlan(page);
    await waitForWorkflowReviewReady(page);

    const alphaId = await resolveTaskId(page, 'task-alpha');
    const betaId = await resolveTaskId(page, 'task-beta');
    const alphaEvents = await page.evaluate((id) => window.invoker.getEvents(id), alphaId);
    const betaEvents = await page.evaluate((id) => window.invoker.getEvents(id), betaId);

    const alphaTypes = alphaEvents.map((e: any) => e.eventType);
    const betaTypes = betaEvents.map((e: any) => e.eventType);

    expect(alphaTypes).toContain('task.running');
    expect(alphaTypes).toContain('task.completed');
    expect(betaTypes).toContain('task.running');
    expect(betaTypes).toContain('task.completed');
  });

  test('merge task review-ready event is logged', async ({ page }) => {
    await loadPlan(page, PERSISTENCE_PLAN);
    await startPlan(page);
    const mergeNodeId = await waitForWorkflowReviewReady(page);
    const events = await page.evaluate((id) => window.invoker.getEvents(id), mergeNodeId);
    const types = events.map((e: any) => e.eventType);
    expect(types).toContain('task.review_ready');
  });
});

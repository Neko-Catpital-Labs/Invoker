import { stringify as yamlStringify } from 'yaml';
import { test, expect, injectTaskStates, getTasks, E2E_REPO_URL } from './fixtures/electron-app.js';

const PLAN = {
  name: 'Workflow Status Composition',
  repoUrl: E2E_REPO_URL,
  onFinish: 'merge' as const,
  tasks: [
    { id: 'alpha', description: 'Alpha task', command: 'echo alpha', dependencies: [] as string[] },
    { id: 'beta', description: 'Beta task', command: 'echo beta', dependencies: ['alpha'] },
  ],
};

async function workflowSnapshot(page: import('@playwright/test').Page) {
  const workflows = await page.evaluate(() => window.invoker.listWorkflows());
  expect(workflows).toHaveLength(1);
  return workflows[0] as any;
}

async function expectWorkflowStatus(page: import('@playwright/test').Page, status: string) {
  await expect.poll(async () => (await workflowSnapshot(page)).status).toBe(status);
  return workflowSnapshot(page);
}

test.describe('Workflow status composition', () => {
  test('workflow status and rollup details follow task state changes', async ({ page }) => {
    await page.evaluate((planYaml) => window.invoker.loadPlan(planYaml), yamlStringify(PLAN));
    await expect.poll(async () => {
      const workflows = await page.evaluate(() => window.invoker.listWorkflows());
      return workflows.length;
    }).toBe(1);

    let workflow = await expectWorkflowStatus(page, 'pending');
    expect(workflow.rollup.countsByStatus.pending).toBe(3);

    await injectTaskStates(page, [
      { taskId: 'alpha', changes: { status: 'running', execution: { startedAt: new Date() } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'running');
    expect(workflow.rollup.countsByStatus.running).toBe(1);

    await injectTaskStates(page, [
      {
        taskId: 'alpha',
        changes: {
          status: 'fixing_with_ai',
          execution: { isFixingWithAI: true, agentSessionId: 'session-alpha', agentName: 'codex' },
        },
      },
    ]);
    workflow = await expectWorkflowStatus(page, 'fixing_with_ai');
    expect(workflow.rollup.fixingTasks).toEqual([
      expect.objectContaining({ taskId: expect.stringContaining('alpha'), agentSessionId: 'session-alpha' }),
    ]);

    await injectTaskStates(page, [
      {
        taskId: 'alpha',
        changes: { status: 'failed', execution: { error: 'alpha exploded', exitCode: 11, isFixingWithAI: false } },
      },
    ]);
    workflow = await expectWorkflowStatus(page, 'failed');
    expect(workflow.rollup.failedTasks).toEqual([
      expect.objectContaining({ taskId: expect.stringContaining('alpha'), error: 'alpha exploded', exitCode: 11 }),
    ]);

    const tasks = await getTasks(page);
    const mergeTask = tasks.find((task: any) => task.config?.isMergeNode);
    expect(mergeTask).toBeTruthy();
    await injectTaskStates(page, [
      { taskId: 'beta', changes: { status: 'failed', execution: { error: 'beta failed differently', exitCode: 22 } } },
      { taskId: mergeTask.id, changes: { status: 'failed', execution: { error: 'merge could not proceed', exitCode: 33 } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'failed');
    expect(workflow.rollup.failedTasks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ error: 'alpha exploded' }),
        expect.objectContaining({ error: 'beta failed differently' }),
        expect.objectContaining({ error: 'merge could not proceed' }),
      ]),
    );

    await injectTaskStates(page, [
      { taskId: 'alpha', changes: { status: 'completed', execution: { error: undefined, exitCode: 0 } } },
      { taskId: 'beta', changes: { status: 'completed', execution: { error: undefined, exitCode: 0 } } },
      { taskId: mergeTask.id, changes: { status: 'review_ready', execution: { error: undefined, reviewUrl: 'https://example.test/review' } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'review_ready');
    expect(workflow.rollup.waitingTasks).toEqual([
      expect.objectContaining({ taskId: mergeTask.id, status: 'review_ready', reviewUrl: 'https://example.test/review' }),
    ]);

    await injectTaskStates(page, [
      { taskId: mergeTask.id, changes: { status: 'awaiting_approval', execution: { inputPrompt: 'Approve merge?' } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'awaiting_approval');
    expect(workflow.rollup.waitingTasks).toEqual([
      expect.objectContaining({ taskId: mergeTask.id, status: 'awaiting_approval', inputPrompt: 'Approve merge?' }),
    ]);

    await injectTaskStates(page, [
      { taskId: mergeTask.id, changes: { status: 'needs_input', execution: { inputPrompt: 'Need operator input' } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'blocked');
    expect(workflow.rollup.waitingTasks).toEqual([
      expect.objectContaining({ taskId: mergeTask.id, status: 'needs_input', inputPrompt: 'Need operator input' }),
    ]);

    await injectTaskStates(page, [
      { taskId: mergeTask.id, changes: { status: 'completed', execution: { inputPrompt: undefined, exitCode: 0 } } },
    ]);
    workflow = await expectWorkflowStatus(page, 'completed');
    expect(workflow.rollup.countsByStatus.completed).toBe(3);

    await injectTaskStates(page, [
      { taskId: 'alpha', changes: { status: 'stale' } },
    ]);
    workflow = await expectWorkflowStatus(page, 'completed');
    expect(workflow.rollup.countsByStatus.completed).toBe(2);
    expect(workflow.rollup.countsByStatus.stale).toBe(1);
  });
});

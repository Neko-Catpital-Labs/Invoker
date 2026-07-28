import { test, expect, TEST_PLAN, loadPlan } from './fixtures/electron-app';

test.use({ guiOwnerMode: 'auto' });

test('startReady delegates to the daemon owner', async ({ page }) => {
  const runtimeStatus = await page.evaluate(async () => window.invoker.getRuntimeStatus());
  expect(runtimeStatus).toEqual({
    ownerMode: false,
    readOnly: false,
    mode: 'daemon-owner',
  });

  await loadPlan(page, TEST_PLAN);

  const result = await page.evaluate(async () => {
    const response = await window.invoker.startReady();
    return {
      dryRun: response.dryRun,
      readyTaskIds: response.preview.readyTaskIds,
      started: response.started.map((task) => ({ id: task.id, status: task.status })),
    };
  });

  expect(result.dryRun).toBe(false);
  expect(result.readyTaskIds.some((taskId) => taskId.endsWith('task-alpha'))).toBe(true);
  expect(result.started).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: expect.stringMatching(/task-alpha$/),
      }),
    ]),
  );

  await page.waitForFunction(async () => {
    const tasksResult = await window.invoker.getTasks();
    const tasks = Array.isArray(tasksResult) ? tasksResult : tasksResult.tasks;
    return tasks.some((task) => task.id.endsWith('task-alpha') && task.status === 'running');
  }, null, { timeout: 10_000 });
});

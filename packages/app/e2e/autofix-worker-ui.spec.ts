import {
  test,
  expect,
  loadPlan,
  startPlan,
  waitForTaskStatus,
  resolveTaskId,
  E2E_REPO_URL,
} from './fixtures/electron-app.js';

test.use({ repoConfig: { autoFixRetries: 2, autoFixAgent: 'claude', autoApproveAIFixes: false } });

const PLAN = {
  name: 'E2E Autofix Worker UI Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'task-pass', description: 'Task that succeeds', command: 'echo ok', dependencies: [] },
    { id: 'task-fail', description: 'Task that fails', command: 'exit 1', dependencies: ['task-pass'] },
  ],
};

test('worker-triggered autofix reaches approval UI with mocked Claude', async ({ page }) => {
  await page.evaluate(async () => {
    await window.invoker.startWorker('autofix');
  });
  await loadPlan(page, PLAN);
  await startPlan(page);
  await waitForTaskStatus(page, 'task-pass', 'completed');
  await waitForTaskStatus(page, 'task-fail', 'awaiting_approval', 30000);

  const scopedTaskId = await resolveTaskId(page, 'task-fail');
  await page.waitForFunction(
    async (taskId) => {
      const parsePayload = (payload: unknown): Record<string, unknown> => {
        if (typeof payload === 'string') {
          try {
            return JSON.parse(payload) as Record<string, unknown>;
          } catch {
            return {};
          }
        }
        return payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
      };

      const events = await window.invoker.getEvents(taskId, { limit: 100, sortBy: 'desc' });
      return events.some((event: { eventType: string }) => event.eventType === 'task.failed')
        && events.some((event: { eventType: string; payload?: unknown }) => {
          const payload = parsePayload(event.payload);
          return event.eventType === 'debug.auto-fix' && payload.phase === 'worker-autofix-submitted';
        })
        && events.some((event: { eventType: string; payload?: unknown }) => {
          const payload = parsePayload(event.payload);
          return event.eventType === 'recovery.worker.submit' && payload.action === 'submit';
        });
    },
    scopedTaskId,
    { timeout: 10000 },
  );

  await page.evaluate(() => window.invoker.refreshTaskGraph());
  await page.waitForTimeout(1000);
  const node = page.locator('.react-flow__node[data-testid$="/task-fail"]');
  await expect(node.locator('text=/Approve/i')).toBeVisible({ timeout: 5000 });
  await expect(node.locator('text=FIXING WITH AI')).not.toBeVisible();

  await node.click();
  await expect(page.getByTestId('inspector-approve-button')).toHaveText('Approve Fix');
});

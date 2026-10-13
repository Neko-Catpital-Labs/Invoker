/**
 * Literal repro of the user's report: rebase + recreate a failed workflow,
 * then just watch the UI. No early exit, no assumptions — log every tick for
 * a long window and report exactly what happened.
 */
import {
  test,
  expect,
  E2E_REPO_URL,
  loadPlan,
  startPlan,
  waitForTaskStatus,
} from './fixtures/electron-app.js';

test.use({
  repoConfig: {
    autoFixRetries: 0,
    maxConcurrency: 13,
  },
});

const FAILING_PLAN = {
  name: 'Rebase Recreate Never Recovers Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'a', description: 'Fails on purpose', command: 'exit 1', dependencies: [] },
  ],
};

test.describe('rebase-recreate: does the UI ever change', () => {
  test('queue chip changes and settles after rebase-recreate', async ({ page }) => {
    test.setTimeout(30_000);

    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'a', 'failed');

    const workflowId = await page.evaluate(async () => {
      const workflows = await window.invoker.listWorkflows();
      return workflows[workflows.length - 1]!.id as string;
    });

    const chipBefore = await page.getByTestId('queue-chip-running').textContent();
    const slotsBefore = await page.getByTestId('queue-chip-slots').textContent();
    console.log(`[before] chip=${chipBefore} slots=${slotsBefore}`);

    const mutationResult = await page.evaluate(
      (wfId) => window.invoker.rebaseRecreate(wfId),
      workflowId,
    );
    console.log(`[mutation] rebaseRecreate result: ${JSON.stringify(mutationResult)}`);

    const startedAt = Date.now();
    const deadline = startedAt + 20_000;
    let lastChip = chipBefore ?? '';
    let lastSlots = slotsBefore ?? '';
    let lastTaskStatus = 'failed';
    let sawActiveWork = false;
    let sawSettledFailure = false;

    while (Date.now() < deadline) {
      const elapsed = Date.now() - startedAt;
      const { chip, slots, taskStatus } = await page.evaluate(async () => {
        const chipText = document.querySelector('[data-testid="queue-chip-running"]')?.textContent ?? null;
        const slotsText = document.querySelector('[data-testid="queue-chip-slots"]')?.textContent ?? null;
        const result = await window.invoker.getTasks();
        const tasks = Array.isArray(result) ? result : result.tasks;
        const taskA = tasks.find((t: { id: string }) => t.id.endsWith('/a'));
        return { chip: chipText, slots: slotsText, taskStatus: taskA?.status ?? 'missing' };
      });

      if (chip !== lastChip || slots !== lastSlots || taskStatus !== lastTaskStatus) {
        console.log(
          `[t=${elapsed}ms] CHANGED -> chip=${chip} slots=${slots} invoker-query-status=${taskStatus}`,
        );
        lastChip = chip ?? '';
        lastSlots = slots ?? '';
        lastTaskStatus = taskStatus;
      }

      if (taskStatus === 'queued' || taskStatus === 'running' || chip === 'Executing (1/1)' || slots === 'Slots (1/1)') {
        sawActiveWork = true;
      }
      if (sawActiveWork && taskStatus === 'failed' && chip === 'Executing (0/1)' && slots === 'Slots (0/1)') {
        sawSettledFailure = true;
        break;
      }

      await page.waitForTimeout(250);
    }

    console.log(`[final t=${Date.now() - startedAt}ms] chip=${lastChip} slots=${lastSlots} invoker-query-status=${lastTaskStatus}`);
    console.log(`[verdict] saw active work after rebase-recreate: ${sawActiveWork}`);
    console.log(`[verdict] saw failed task settle back to idle chrome: ${sawSettledFailure}`);

    expect(sawActiveWork).toBe(true);
    expect(sawSettledFailure).toBe(true);
  });
});

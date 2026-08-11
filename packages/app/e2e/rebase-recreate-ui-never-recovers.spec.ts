/**
 * Literal repro of the user's report: rebase + recreate a failed workflow,
 * then just watch the UI. No early exit, no assumptions — log every tick for
 * a long window and report exactly what happened.
 */
import {
  test,
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
  test('watch the queue chip for 60s after rebase-recreate, no early exit', async ({ page }) => {
    test.setTimeout(90_000);

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
    const deadline = startedAt + 60_000;
    let lastChip = '';
    let lastSlots = '';
    let lastTaskStatus = '';
    let changedAtLeastOnce = false;

    while (Date.now() < deadline) {
      const elapsed = Date.now() - startedAt;
      const chip = await page.getByTestId('queue-chip-running').textContent();
      const slots = await page.getByTestId('queue-chip-slots').textContent();
      const tasks = await page.evaluate(async () => {
        const result = await window.invoker.getTasks();
        return Array.isArray(result) ? result : result.tasks;
      });
      const taskA = tasks.find((t: { id: string }) => t.id.endsWith('/a'));

      if (chip !== lastChip || slots !== lastSlots || taskA.status !== lastTaskStatus) {
        changedAtLeastOnce = true;
        console.log(
          `[t=${elapsed}ms] CHANGED -> chip=${chip} slots=${slots} invoker-query-status=${taskA.status}`,
        );
        lastChip = chip ?? '';
        lastSlots = slots ?? '';
        lastTaskStatus = taskA.status;
      }

      await page.waitForTimeout(500);
    }

    console.log(`[final t=60000ms] chip=${lastChip} slots=${lastSlots} invoker-query-status=${lastTaskStatus}`);
    console.log(`[verdict] did the UI ever change after rebase-recreate: ${changedAtLeastOnce}`);
  });
});

/**
 * E2E perf gate: workflow delete propagation latency.
 *
 * Measures the wall-clock time from the window.invoker.deleteWorkflow()
 * bridge call to the workflow node leaving the DOM, sampled per animation
 * frame, and enforces a propagation budget with headroom for full-suite load.
 */

import { expect, test, TEST_PLAN, loadPlan } from './fixtures/electron-app.js';

const DELETE_PROPAGATION_BUDGET_MS = 2_000;

test('workflow delete reaches the graph within the propagation budget', async ({ page }) => {
  await loadPlan(page, TEST_PLAN);
  const workflowId = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows[workflows.length - 1]?.id as string;
  });

  const latency = await page.evaluate(async (id) => {
    const selector = `[data-testid="rf__node-${id}"]`;
    const gone = new Promise<number>((resolve) => {
      const check = () => {
        if (!document.querySelector(selector)) {
          resolve(performance.now());
        } else {
          requestAnimationFrame(check);
        }
      };
      requestAnimationFrame(check);
    });
    const startedAt = performance.now();
    await window.invoker.deleteWorkflow(id);
    const acceptedAt = performance.now();
    const goneAt = await gone;
    return { totalMs: goneAt - startedAt, acceptRoundtripMs: acceptedAt - startedAt };
  }, workflowId);

  console.log(
    `workflow-delete-latency: total=${latency.totalMs.toFixed(1)}ms ` +
      `acceptRoundtrip=${latency.acceptRoundtripMs.toFixed(1)}ms`,
  );
  expect(latency.totalMs).toBeLessThan(DELETE_PROPAGATION_BUDGET_MS);
});

/**
 * Repro: does the rendered UI (the actual DOM the user looks at) ever show a
 * stale status while the backend (invoker query / sqlite) has already moved
 * on, right after a rebase-recreate on a failed workflow?
 */
import { DatabaseSync } from 'node:sqlite';
import * as path from 'node:path';
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
    maxConcurrency: 1,
  },
});

const FAILING_PLAN = {
  name: 'Rebase Recreate UI Drift Repro',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    { id: 'a', description: 'Fails on purpose so we can rebase-recreate it', command: 'exit 1', dependencies: [] },
  ],
};

test.describe('rebase-recreate UI drift repro', () => {
  test('UI chip, invoker query, and raw sqlite must agree right after rebase-recreate', async ({ page, testDir }) => {
    await loadPlan(page, FAILING_PLAN);
    await startPlan(page);
    await waitForTaskStatus(page, 'a', 'failed');

    const workflowId = await page.evaluate(async () => {
      const workflows = await window.invoker.listWorkflows();
      return workflows[workflows.length - 1]!.id as string;
    });

    // Queue chips live on Plan graph bottom chrome (not Planning home) —
    // see e2e/queue-running-vs-queued.spec.ts. loadPlan already leaves us here.
    const chipBefore = await page.getByTestId('queue-chip-running').textContent();
    console.log(`[before] UI chip: ${chipBefore}`);

    // rebase-recreate = "refresh pool base, then recreate workflow"
    // (packages/app/src/headless-usage.ts:45). The facade awaits the whole
    // thing (packages/app/src/workflow-mutation-facade.ts:340-345) before
    // this promise resolves.
    const { mutationResult, tasks: tasksRightAfterRecreate } = await page.evaluate(async (wfId) => {
      const mutationResult = await window.invoker.rebaseRecreate(wfId);
      const result = await window.invoker.getTasks();
      return { mutationResult, tasks: Array.isArray(result) ? result : result.tasks };
    }, workflowId);
    console.log(`[mutation] rebaseRecreate result: ${JSON.stringify(mutationResult)}`);

    const taskAAfter = tasksRightAfterRecreate.find((t: { id: string }) => t.id.endsWith('/a'));

    // Read the real sqlite file directly — a second, independent connection,
    // completely bypassing the Electron process, the orchestrator, and every
    // in-memory cache.
    const dbPath = path.join(testDir, 'invoker.db');
    const db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare('SELECT id, status FROM tasks WHERE id = ?').get(taskAAfter.id) as
      | { id: string; status: string }
      | undefined;
    db.close();

    // The rendered DOM, read immediately (no artificial wait) after the
    // above resolved — this is literally what the user's screen shows.
    const chipAfter = await page.getByTestId('queue-chip-running').textContent();

    console.log(`[after] sqlite row status: ${row?.status}`);
    console.log(`[after] invoker query (getTasks) status: ${taskAAfter.status}`);
    console.log(`[after] UI chip DOM text: ${chipAfter}`);

    expect(row?.status).toBe(taskAAfter.status);

    // "accepted:true" only means the mutation intent was queued
    // (packages/app/src/persisted-workflow-mutation-coordinator.ts), not that
    // it has landed. Poll all three sources every 50ms for 5s and log every
    // tick, so any transient disagreement between what sqlite has, what
    // invoker query reports, and what's actually painted on screen shows up
    // in the log instead of being masked by a single end-state check.
    const startedAt = Date.now();
    const deadline = startedAt + 8000;
    let tick = 0;
    let sawDisagreement = false;
    let backendFlippedAtMs: number | null = null;
    let chipCaughtUpAtMs: number | null = null;

    while (Date.now() < deadline) {
      tick += 1;
      const elapsed = Date.now() - startedAt;

      const polled = await page.evaluate(async () => {
        const result = await window.invoker.getTasks();
        return Array.isArray(result) ? result : result.tasks;
      });
      const polledTaskA = polled.find((t: { id: string }) => t.id.endsWith('/a'));

      const db2 = new DatabaseSync(dbPath, { readOnly: true });
      const polledRow = db2.prepare('SELECT status FROM tasks WHERE id = ?').get(polledTaskA.id) as
        | { status: string }
        | undefined;
      db2.close();

      const polledChip = await page.getByTestId('queue-chip-running').textContent();

      if (polledTaskA.status === 'running' && backendFlippedAtMs === null) backendFlippedAtMs = elapsed;
      const chipShowsRunning = polledChip === 'Executing (1/1)';
      if (chipShowsRunning && chipCaughtUpAtMs === null) chipCaughtUpAtMs = elapsed;

      const agree = polledRow?.status === polledTaskA.status
        && (polledTaskA.status === 'running' ? chipShowsRunning : polledChip === 'Executing (0/1)');
      if (!agree) sawDisagreement = true;

      console.log(
        `[poll ${tick} t=${elapsed}ms] sqlite=${polledRow?.status} invoker-query=${polledTaskA.status} ui-chip=${polledChip} agree=${agree}`,
      );

      if (chipCaughtUpAtMs !== null) break;
      await page.waitForTimeout(50);
    }

    console.log(`[summary] backend (sqlite+query) showed running at t=${backendFlippedAtMs}ms`);
    console.log(`[summary] UI chip caught up at t=${chipCaughtUpAtMs}ms`);
    console.log(`[summary] drift window = ${chipCaughtUpAtMs !== null && backendFlippedAtMs !== null ? chipCaughtUpAtMs - backendFlippedAtMs : 'unknown'}ms`);

    expect(sawDisagreement).toBe(false);
  });
});

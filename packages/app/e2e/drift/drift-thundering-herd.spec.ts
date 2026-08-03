/**
 * Dedicated UI/backend drift check under burst load: fires a mix of
 * IPC-driven mutating operations (from scenario-catalog.ts) CONCURRENTLY
 * across several workflows in one Electron session, then asserts every
 * operation's effect eventually converges in the renderer.
 *
 * Scope is drift only -- this is not a general chaos/responsiveness test.
 * For process-count/renderer-responsiveness under a headless-CLI retry burst,
 * see packages/app/e2e/headless-thundering-herd.spec.ts. For broader failure
 * modes, see scripts/e2e-chaos/run-overload.sh.
 */
if (!process.env.INVOKER_TRACE_UI_DELTA) process.env.INVOKER_TRACE_UI_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH) process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH = '1';
if (!process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA) process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS) process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS = '1';

import { expect, test } from '../fixtures/electron-app.js';
import { scenarioById } from './scenario-catalog.js';
import { compareDriftTimeline } from './trace-compare.js';

// IPC-driven scenarios only (driver: 'ipc') -- headless-CLI-driven bursts are
// a distinct, already-covered concern (headless-thundering-herd.spec.ts).
// Excludes 'run': submitting a brand-new plan concurrently with mutations on
// other workflows hits a separate, test-fixture-specific race in the
// deterministic INVOKER_TEST_WORKFLOW_IDS=1 id counter (not a production
// concern -- real ids are random) and 'run' already has dedicated single-op
// coverage in drift-single-op.spec.ts.
const BURST_SCENARIO_IDS = [
  'retry-task',
  'cancel-task',
  'approve',
  'reject',
  'edit-task-command',
  'detach-workflow',
  'delete-task',
  'set-workflow-merge-mode',
  'set-merge-branch',
];

test.describe('UI/backend drift — thundering herd', () => {
  test('a burst of concurrent operations across many workflows all eventually converge', async ({ page, testDir }) => {
    const scenarios = BURST_SCENARIO_IDS.map(scenarioById);

    // Setup phase runs sequentially -- each scenario builds its own
    // workflow(s)/preconditions and this isn't itself the condition under
    // test.
    const prepared: Array<{ scenario: (typeof scenarios)[number]; ctx: Awaited<ReturnType<(typeof scenarios)[number]['setup']>> }> = [];
    for (const scenario of scenarios) {
      prepared.push({ scenario, ctx: await scenario.setup(page, testDir) });
    }

    // Burst phase: fire every operation's mutating IPC call concurrently.
    // This is the actual thundering-herd condition -- many nearly-simultaneous
    // invoker:* IPC calls landing on the same coalescing windows at once.
    const burstStartedAt = Date.now();
    const results = await Promise.all(
      prepared.map(({ scenario, ctx }) => scenario.act(ctx).then((result) => ({ scenario, result }))),
    );
    const burstWallMs = Date.now() - burstStartedAt;

    // Let both coalescing windows (25ms task-graph batch, 50ms
    // workflow-metadata flush) settle well past their max before reading the
    // trace files back.
    await page.waitForTimeout(2000);

    const comparisons = results.map(({ scenario, result }) => ({
      scenario: scenario.id,
      channel: scenario.channel,
      workflowId: result.workflowId,
      comparison: compareDriftTimeline(scenario.channel, testDir, result.workflowId),
    }));

    const failed = comparisons.filter((entry) => !entry.comparison.ok);
    const evidence = {
      burstWallMs,
      scenarioCount: scenarios.length,
      failedCount: failed.length,
      failed,
      all: comparisons,
    };
    expect(failed.length, JSON.stringify(evidence, null, 2)).toBe(0);
  });
});

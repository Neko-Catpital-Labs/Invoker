/**
 * Combinatorial "battery" coverage over the drift scenario catalog.
 *
 * Default (no env var): pairwise coverage over a curated core subset, plus a
 * handful of seeded random-fuzz subsets -- fast enough to run on demand.
 * INVOKER_DRIFT_BATTERY_MODE=nightly: full pairwise coverage over every
 * IPC-driven scenario in the catalog (excludes headless-CLI-driven scenarios,
 * whose concurrent-process concerns are already covered by
 * packages/app/e2e/headless-thundering-herd.spec.ts). This mirrors the
 * core/@nightly catalog-expansion pattern in scripts/e2e-chaos/run-overload.sh.
 *
 * This harness stays opt-in / manually run, not wired into required CI.
 */
if (!process.env.INVOKER_TRACE_UI_DELTA) process.env.INVOKER_TRACE_UI_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH) process.env.INVOKER_TRACE_RENDERER_TASK_GRAPH = '1';
if (!process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA) process.env.INVOKER_TRACE_UI_WORKFLOW_DELTA = '1';
if (!process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS) process.env.INVOKER_TRACE_RENDERER_WORKFLOW_EVENTS = '1';

import { expect, test } from '../fixtures/electron-app.js';
import { DRIFT_SCENARIOS } from './scenario-catalog.js';
import { pairwiseCombinations, randomFuzzSubsets, runConcurrentBattery, seedFromString } from './battery-runner.js';

const MODE = process.env.INVOKER_DRIFT_BATTERY_MODE === 'nightly' ? 'nightly' : 'core';
const SEED = seedFromString(process.env.INVOKER_DRIFT_BATTERY_SEED ?? 'invoker-drift-battery-default-seed');
const FUZZ_ITERATIONS = Number.parseInt(process.env.INVOKER_DRIFT_BATTERY_FUZZ_ITERATIONS ?? '5', 10);
const FUZZ_SIZE = Number.parseInt(process.env.INVOKER_DRIFT_BATTERY_FUZZ_SIZE ?? '3', 10);

// Excludes 'run': concurrently submitting a brand-new plan alongside
// mutations on other workflows hits a separate, test-fixture-specific race in
// the deterministic INVOKER_TEST_WORKFLOW_IDS=1 id counter (not a production
// concern -- real ids are random); 'run' already has dedicated single-op
// coverage in drift-single-op.spec.ts.
// Excludes 'delete-all-workflows': it wipes every workflow in the shared test
// DB, so pairing it with any concurrent sibling necessarily corrupts that
// sibling's own workflow underneath it -- a scenario-composition artifact,
// not a channel drift bug. Also covered individually in drift-single-op.spec.ts.
const EXCLUDED_FROM_COMBINATORICS = new Set(['run', 'delete-all-workflows']);
const IPC_DRIVEN_IDS = DRIFT_SCENARIOS
  .filter((s) => s.driver === 'ipc' && !EXCLUDED_FROM_COMBINATORICS.has(s.id))
  .map((s) => s.id);

const CORE_BATTERY_IDS = [
  'retry-task',
  'cancel-task',
  'approve',
  'detach-workflow',
  'delete-task',
  'set-workflow-merge-mode',
];

const batteryIds = MODE === 'nightly' ? IPC_DRIVEN_IDS : CORE_BATTERY_IDS;

test.describe(`UI/backend drift — combinatorial battery (${MODE})`, () => {
  test('every pairwise combination of concurrent operations converges', async ({ page, testDir }) => {
    test.setTimeout(MODE === 'nightly' ? 45 * 60_000 : 10 * 60_000);
    const pairs = pairwiseCombinations(batteryIds);
    const runs = [];
    for (const [a, b] of pairs) {
      runs.push(await runConcurrentBattery(page, testDir, [a, b], `${a} + ${b}`));
    }

    const failed = runs.filter((run) => !run.ok);
    const evidence = {
      mode: MODE,
      pairCount: pairs.length,
      failedCount: failed.length,
      failed,
    };
    expect(failed.length, JSON.stringify(evidence, null, 2)).toBe(0);
  });

  test('random-fuzz subsets of concurrent operations converge', async ({ page, testDir }) => {
    test.setTimeout(10 * 60_000);
    const subsets = randomFuzzSubsets(IPC_DRIVEN_IDS, FUZZ_ITERATIONS, FUZZ_SIZE, SEED);
    const runs = [];
    for (const subset of subsets) {
      runs.push(await runConcurrentBattery(page, testDir, subset, subset.join(' + ')));
    }

    const failed = runs.filter((run) => !run.ok);
    const evidence = {
      seed: SEED,
      iterations: FUZZ_ITERATIONS,
      size: FUZZ_SIZE,
      failedCount: failed.length,
      failed,
    };
    expect(failed.length, JSON.stringify(evidence, null, 2)).toBe(0);
  });
});

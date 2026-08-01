/**
 * Combinatorial/permutation coverage over the scenario catalog ("battery
 * testing"). Full factorial permutation over ~20+ operations is
 * combinatorially infeasible, so this scopes to:
 *   - pairwise (2-wise) coverage: every ordered pair run concurrently
 *   - randomized fuzz: seeded random subsets run concurrently, repeated
 * mirroring the core/@nightly catalog-expansion pattern already used in
 * scripts/e2e-chaos/run-overload.sh.
 */
import type { Page } from '@playwright/test';
import { deleteAllWorkflowsFast } from '../fixtures/electron-app.js';
import { scenarioById, type DriftScenario } from './scenario-catalog.js';
import { compareDriftTimeline, type TimelineComparisonResult } from './trace-compare.js';

export interface BatteryRunResult {
  label: string;
  scenarioIds: string[];
  wallMs: number;
  comparisons: Array<{ scenarioId: string; channel: DriftScenario['channel']; workflowId: string; comparison: TimelineComparisonResult }>;
  ok: boolean;
}

/** Deterministic PRNG (mulberry32) so fuzz batteries are reproducible by default. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seedFromString(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (Math.imul(31, hash) + seed.charCodeAt(i)) | 0;
  }
  return hash;
}

/** Every ordered pair (a, b) with a !== b -- full pairwise coverage of the catalog. */
export function pairwiseCombinations(ids: readonly string[]): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const a of ids) {
    for (const b of ids) {
      if (a !== b) pairs.push([a, b]);
    }
  }
  return pairs;
}

/** `count` random subsets of `size` distinct ids, seeded for reproducibility. */
export function randomFuzzSubsets(ids: readonly string[], count: number, size: number, seed: number): string[][] {
  const rng = mulberry32(seed);
  const subsets: string[][] = [];
  for (let i = 0; i < count; i += 1) {
    const pool = [...ids];
    const subset: string[] = [];
    for (let k = 0; k < Math.min(size, pool.length); k += 1) {
      const index = Math.floor(rng() * pool.length);
      subset.push(pool.splice(index, 1)[0]);
    }
    subsets.push(subset);
  }
  return subsets;
}

/** Run one battery entry: set up every scenario, fire all their acts concurrently, compare all. */
export async function runConcurrentBattery(
  page: Page,
  testDir: string,
  scenarioIds: readonly string[],
  label: string,
): Promise<BatteryRunResult> {
  // A battery runs many entries in one long-lived Electron session for cost
  // reasons (see plan). The deterministic INVOKER_TEST_WORKFLOW_IDS=1 ids used
  // in e2e tests are a small, reused id space (wf-test-1, wf-test-2, ...) --
  // without clearing state between entries, a later entry's id can collide
  // with an earlier entry's still-lingering workflow, corrupting its merge
  // node. Starting from a clean slate avoids this test-fixture artifact.
  await deleteAllWorkflowsFast(page);

  const scenarios = scenarioIds.map(scenarioById);
  const prepared: Array<{ scenario: DriftScenario; ctx: Awaited<ReturnType<DriftScenario['setup']>> }> = [];
  for (const scenario of scenarios) {
    prepared.push({ scenario, ctx: await scenario.setup(page, testDir) });
  }

  const startedAt = Date.now();
  const results = await Promise.all(
    prepared.map(({ scenario, ctx }) => scenario.act(ctx).then((result) => ({ scenario, result }))),
  );
  const wallMs = Date.now() - startedAt;

  await page.waitForTimeout(2000);

  const comparisons = results.map(({ scenario, result }) => ({
    scenarioId: scenario.id,
    channel: scenario.channel,
    workflowId: result.workflowId,
    comparison: compareDriftTimeline(scenario.channel, testDir, result.workflowId),
  }));

  return {
    label,
    scenarioIds: [...scenarioIds],
    wallMs,
    comparisons,
    ok: comparisons.every((entry) => entry.comparison.ok),
  };
}

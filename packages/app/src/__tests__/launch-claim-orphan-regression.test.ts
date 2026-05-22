/**
 * Regression test for the 2026-05-22T01:55:56 launch-claim orphan storm.
 *
 * Background (see docs/incidents/2026-05-22-launch-handoff-orphan-architecture.md):
 *  - 38 concurrent `rebase-recreate` mutations were dispatched.
 *  - The orchestrator wrote `task.launch_claimed` for every claimed
 *    attempt (durable state).
 *  - The fire-and-forget hand-off to the TaskRunner was lost for four
 *    of the claims, so no terminal launch event was ever written.
 *  - Those four claims sat in `pending/launching` for ~20 minutes
 *    before the watchdog failed them with the misleading
 *    "60 seconds" error message.
 *
 * This test reproduces the steady-state shape in-process: 38 single-task
 * plans are loaded, `startExecution()` is called to claim every
 * attempt, and **no TaskRunner is wired in** — exactly the fragile
 * seam the re-architecture is meant to eliminate.
 *
 * The test is marked `it.fails` so CI stays green while the bug is
 * documented. The Phase B definition of done (see
 * .cursor/plans/launch_handoff_rearchitecture_c13d3ffc.plan.md) calls
 * for removing the `.fails` marker once the durable
 * `task_launch_dispatch` outbox dispatcher is active and resolves
 * every claim.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { Orchestrator, type PlanDefinition } from '@invoker/workflow-core';
import { InMemoryBus } from '@invoker/test-kit';
import {
  LAUNCH_CLAIM_EVENT_TYPE,
  LaunchInvariantViolationError,
  TERMINAL_LAUNCH_EVENT_TYPES,
  assertLaunchInvariant,
} from './launch-invariant.js';

const STORM_SIZE = 38;
const TIGHT_MAX_GAP_MS = 60_000;
const PRETEND_LATER_MS = 10 * 60 * 1000; // 10 minutes after `now`

describe('launch-claim orphan regression (2026-05-22 storm)', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) {
      adapter.close();
    }
  });

  it.fails(
    'a 38-claim rebase-recreate storm without a dispatcher orphans every claim',
    async () => {
      const persistence = await SQLiteAdapter.create(':memory:');
      adapters.push(persistence);

      const orchestrator = new Orchestrator({
        persistence: persistence as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: STORM_SIZE,
        // Mirror production wiring (packages/app/src/main.ts:502) — without
        // this flag the orchestrator writes `task.running` directly and skips
        // the two-phase claim/launch hand-off that the bug lives in.
        deferRunningUntilLaunch: true,
      });

      for (let i = 0; i < STORM_SIZE; i++) {
        const plan: PlanDefinition = {
          name: `rebase-recreate-storm-${i}`,
          baseBranch: 'master',
          featureBranch: `experiment/storm-${i}`,
          tasks: [
            {
              id: `t-${i}`,
              description: `Storm task ${i}`,
              command: `echo storm-${i}`,
            },
          ],
        };
        orchestrator.loadPlan(plan);
      }

      orchestrator.startExecution();

      const claimCount = persistence
        .getAllTaskIds()
        .reduce(
          (acc, taskId) =>
            acc +
            persistence
              .getEvents(taskId)
              .filter((event) => event.eventType === LAUNCH_CLAIM_EVENT_TYPE)
              .length,
          0,
        );
      expect(claimCount).toBe(STORM_SIZE);

      const terminalCount = persistence
        .getAllTaskIds()
        .reduce(
          (acc, taskId) =>
            acc +
            persistence
              .getEvents(taskId)
              .filter((event) => TERMINAL_LAUNCH_EVENT_TYPES.has(event.eventType))
              .length,
          0,
        );
      expect(terminalCount).toBe(0);

      try {
        assertLaunchInvariant(persistence, {
          maxGapMs: TIGHT_MAX_GAP_MS,
          nowMs: Date.now() + PRETEND_LATER_MS,
        });
      } catch (err) {
        expect(err).toBeInstanceOf(LaunchInvariantViolationError);
        const violation = err as LaunchInvariantViolationError;
        expect(violation.summary.claimCount).toBe(STORM_SIZE);
        expect(violation.violations).toHaveLength(STORM_SIZE);
        for (const v of violation.violations) {
          expect(v.reason).toBe('no_terminal_event');
        }
        throw err;
      }
    },
  );
});

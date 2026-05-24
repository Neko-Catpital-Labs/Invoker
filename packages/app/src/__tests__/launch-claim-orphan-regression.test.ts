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
 * The first case reproduces the original orphan shape: 38 single-task
 * plans are loaded, `startExecution()` is called to claim every
 * attempt, and **no LaunchDispatcher polls the outbox** — so the
 * outbox rows accumulate but are never serviced. The invariant must
 * detect this (`no_terminal_event` violations). This stands in for
 * the worst-case "owner crashed before dispatching" scenario.
 *
 * The second case wires the LaunchDispatcher (which is always-on in
 * production) and verifies the invariant holds end-to-end: every
 * claim reaches a terminal launch event.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { Orchestrator, type PlanDefinition, type TaskState } from '@invoker/workflow-core';
import { InMemoryBus } from '@invoker/test-kit';
import { LaunchDispatcher } from '../launch-dispatcher.js';
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

  it(
    'a 38-claim rebase-recreate storm with no dispatcher polling still orphans every claim (invariant detects it)',
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

      let caught: unknown = null;
      try {
        assertLaunchInvariant(persistence, {
          maxGapMs: TIGHT_MAX_GAP_MS,
          nowMs: Date.now() + PRETEND_LATER_MS,
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(LaunchInvariantViolationError);
      const violation = caught as LaunchInvariantViolationError;
      expect(violation.summary.claimCount).toBe(STORM_SIZE);
      expect(violation.violations).toHaveLength(STORM_SIZE);
      for (const v of violation.violations) {
        expect(v.reason).toBe('no_terminal_event');
      }
    },
  );

  it(
    'with the LaunchDispatcher polling, every claim resolves to a terminal event',
    async () => {
      // CB.5 acceptance: wire the same 38-claim storm through the durable
      // outbox dispatcher (orchestrator -> task_launch_dispatch ->
      // LaunchDispatcher -> fake TaskRunner). The invariant must hold:
      // every `task.launch_claimed` reaches a terminal launch event.
      const persistence = await SQLiteAdapter.create(':memory:');
      adapters.push(persistence);

      const orchestrator = new Orchestrator({
        persistence: persistence as any,
        messageBus: new InMemoryBus(),
        maxConcurrency: STORM_SIZE,
        deferRunningUntilLaunch: true,
      });

      const startedTasks: TaskState[] = [];
      const fakeTaskRunner = {
        async executeTask(
          task: TaskState,
          opts?: { dispatchId: number; launchOutbox: LaunchDispatcher },
        ): Promise<void> {
          startedTasks.push(task);
          if (!opts) return;
          const accepted = opts.launchOutbox.ackDispatch(opts.dispatchId, 'fake-runner');
          if (!accepted) return;
          // Mark the task as running synchronously: this writes a terminal
          // launch event (`task.running`) which satisfies the invariant.
          const attemptId = task.execution.selectedAttemptId;
          if (attemptId) {
            orchestrator.markTaskRunningAfterLaunch(task.id, attemptId);
          }
          opts.launchOutbox.completeDispatch(opts.dispatchId);
        },
      };

      const dispatcher = new LaunchDispatcher({
        persistence,
        orchestrator: {
          prepareTaskForNewAttempt: (taskId, reason) =>
            orchestrator.prepareTaskForNewAttempt(taskId, reason),
          getTask: (taskId) => orchestrator.getTask(taskId),
        },
        taskRunnerProvider: () => fakeTaskRunner,
        ownerId: 'cb5-test-owner',
        maxConcurrency: STORM_SIZE,
        maxLeasesPerPoll: STORM_SIZE,
      });

      for (let i = 0; i < STORM_SIZE; i++) {
        const plan: PlanDefinition = {
          name: `rebase-recreate-storm-active-${i}`,
          baseBranch: 'master',
          featureBranch: `experiment/storm-active-${i}`,
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
      // Single poll handles every row because maxLeasesPerPoll is STORM_SIZE.
      dispatcher.poll();
      // Drain microtasks so the dispatcher's promise chain (and the
      // synchronous markTaskRunningAfterLaunch inside the fake runner) all
      // commit before the invariant check.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(startedTasks).toHaveLength(STORM_SIZE);

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
      expect(terminalCount).toBeGreaterThanOrEqual(STORM_SIZE);

      // The invariant must hold: no orphaned claims.
      assertLaunchInvariant(persistence, {
        maxGapMs: TIGHT_MAX_GAP_MS,
        nowMs: Date.now() + PRETEND_LATER_MS,
      });
    },
  );
});

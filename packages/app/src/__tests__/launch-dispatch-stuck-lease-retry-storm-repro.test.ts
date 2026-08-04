import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import {
  DISPATCH_LEASE_MS,
  LAUNCH_STUCK_ABANDON_MS,
  MAX_STUCK_LEASE_RETRIES,
  type Logger,
} from '@invoker/contracts';
import { LaunchDispatcher } from '../launch-dispatcher.js';

/**
 * Repro for the 2026-08 fix-ci retry storm (~$1,032 in one 24h window, one
 * task retried 78 times on the same unresolved commit).
 *
 * Root cause, in two parts:
 *
 * 1. Commit 3623f6a96 ("Complete dispatch after executor finish", #6210,
 *    2026-07-27) moved `completeDispatch()` out of the launch-accepted path
 *    and into the executor's `onComplete` handler
 *    (packages/execution-engine/src/task-runner-finalize.ts:118-121). A
 *    launch-dispatch row now stays "leased" for the task's ENTIRE runtime,
 *    not just its launch handoff.
 * 2. `LAUNCH_STUCK_ABANDON_MS` (packages/contracts/src/launch-timeouts.ts)
 *    is only 12 minutes, and was only ever meant to catch a launch that
 *    hangs before the executor starts. `abandonStuckLeases()` runs every
 *    poll tick and abandons + calls `prepareTaskForNewAttempt` for ANY row
 *    older than that, with no cap on repeats: each fresh attempt gets a
 *    brand-new `task_launch_dispatch` row with `attempts_count` back at 0,
 *    so `DISPATCH_MAX_ATTEMPTS` (3) never accumulates across cycles.
 *
 * Net effect: a task whose real work legitimately takes longer than 12
 * minutes (e.g. waiting on a slow Playwright CI run) gets torn down and
 * relaunched from scratch forever, on a fixed ~12-minute cadence, with no
 * stopper anywhere in the loop.
 *
 * This test simulates exactly that: a task that is claimed and never
 * completes (mirrors the fix-ci codex sessions, most of which ended in
 * `turn_aborted` after ~700-720s in the real session logs) is put through
 * repeated 12-minute stuck-lease cycles. It asserts the launch-dispatcher
 * must stop retrying after a bounded number of cycles.
 */
describe('launch-dispatcher stuck-lease retry storm', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function makeLogger(): Logger {
    return {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
      child(): Logger {
        return this;
      },
    };
  }

  it('does not retry a task whose launch dispatch never completes forever', () => {
    adapter.saveWorkflow({
      id: 'wf-storm',
      name: 'wf-storm',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    adapter.saveTask('wf-storm', {
      id: 'wf-storm/fix-ci',
      description: 'Diagnose and fix CI job `playwright / 1-of-9`',
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: { workflowId: 'wf-storm' },
      execution: {},
      taskStateVersion: 1,
    });

    const prepare = vi.fn();
    const dispatcher = new LaunchDispatcher({
      persistence: adapter,
      orchestrator: { prepareTaskForNewAttempt: prepare },
      ownerId: 'owner-test',
      logger: makeLogger(),
    });

    // Simulate 10 twelve-minute cycles (~2 hours) of: the task launches
    // successfully, the agent is still legitimately working when the
    // 12-minute stuck-launch window closes, completeDispatch was never
    // called (because it now only fires on full task completion), so the
    // reaper abandons the lease and prepares a brand new attempt. Repeat.
    const CYCLES = 10;
    let simNow = Date.parse('2026-08-02T05:48:00.000Z');

    for (let i = 0; i < CYCLES; i += 1) {
      const row = adapter.enqueueLaunchDispatch({
        taskId: 'wf-storm/fix-ci',
        attemptId: `attempt-cycle-${i}`,
        workflowId: 'wf-storm',
        generation: i,
      });
      const claimedIso = new Date(simNow).toISOString();
      const fencedUntilIso = new Date(simNow + DISPATCH_LEASE_MS - 1_000).toISOString();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (adapter as any).db.run(
        `UPDATE task_launch_dispatch
           SET state = 'leased', dispatch_owner = 'owner-test',
               enqueued_at = ?, fenced_until = ?
         WHERE id = ?`,
        [claimedIso, fencedUntilIso, row.id],
      );

      // Advance the clock past both the fence and the stuck-launch age
      // cutoff, exactly like the real ~12-minute retry cadence observed in
      // the fleet cost data.
      simNow += LAUNCH_STUCK_ABANDON_MS + 60_000;
      dispatcher.abandonStuckLeases(new Date(simNow).toISOString());
    }

    // A task that is still legitimately running (never completes) must
    // eventually stop being torn down and relaunched. Without a cap this
    // fires once per cycle, unbounded -- exactly the $760 fix-ci retry
    // storm observed in production.
    expect(prepare.mock.calls.length).toBeLessThanOrEqual(MAX_STUCK_LEASE_RETRIES);
    expect(prepare.mock.calls.length).toBeLessThan(CYCLES);
  });
});

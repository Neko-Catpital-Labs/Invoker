import { afterEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type PlanDefinition } from '@invoker/workflow-core';

/**
 * Reproduces the production incident from this session: converting ~150
 * already-pending tasks to a runnable pool/agent made all of them
 * simultaneously dispatchable. That triggered LaunchDispatcher's 2-second
 * poll tick to call Orchestrator.startExecution() for all 150 at once,
 * blocking the owner process's event loop long enough to time out unrelated
 * IPC mutation commands (their reply window is 5s, see
 * packages/app/src/headless-delegation.ts).
 *
 * Each task here is an independent single-task workflow (no dependencies),
 * so it's 'pending' and ready the instant loadPlan() runs — matching the
 * real incident, where the 150 tasks were 'pending' the whole time and
 * simply weren't being dispatched (misrouted to an overloaded SSH pool),
 * not tasks unblocked by a dependency completing.
 *
 * getTaskLaunchReadinessImpl() (packages/workflow-core/src/orchestrator/
 * scheduler-domain.ts) used to call refreshFromDb() -- reloading every
 * active workflow's tasks from the DB -- once per ready task inside
 * planPendingLaunchQueue()'s map and once more per dequeued job inside
 * drainSchedulerImpl()'s while loop, on top of startExecution()'s own
 * initial refresh. That made a single startExecution() call cost roughly
 * `1 + 2*readyTaskCount` full task-table reloads instead of one, and was
 * the actual driver of this blocking (confirmed live on a larger DB via
 * `[SQLiteAdapter] slow query summary`, INV-279). The capped
 * `{ limit: 32 }` mitigation below only capped how many jobs get marked
 * launch-ready per poll -- it did not stop drainScheduler from still
 * readiness-checking (and re-refreshing for) every non-ready job left in
 * the queue, so it did not fix the underlying blocking for a large
 * backlog. This first test used to assert the blocking WAS present
 * (>500ms); now that refreshFromDb() is called a small constant number of
 * times per startExecution() regardless of ready-task count, it asserts
 * the blocking stays bounded instead.
 */

const BURST_TASK_COUNT = 150;
function singleTaskWorkflow(name: string): PlanDefinition {
  return {
    name,
    tasks: [{ id: 'run', description: `${name}/run`, command: 'sleep 3600', dependencies: [] }],
  };
}

describe('launch-dispatcher topUpReadyLaunches event-loop lag', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    for (const adapter of adapters.splice(0)) adapter.close();
  });

  /**
   * Builds BURST_TASK_COUNT independent single-task workflows. Every task is
   * 'pending' (ready) the instant loadPlan() returns — no startExecution()
   * or handleWorkerResponse() call happens during setup, so the burst is
   * fully intact for whichever startExecution() call the test measures.
   */
  async function buildBurstOrchestrator(): Promise<{ orchestrator: Orchestrator; persistence: SQLiteAdapter }> {
    const persistence = await SQLiteAdapter.create(':memory:');
    adapters.push(persistence);
    const orchestrator = new Orchestrator({
      persistence: persistence as any,
      messageBus: new InMemoryBus(),
      // Large on purpose: isolates startExecution()'s own cost from the
      // separate, already-bounded drainScheduler concurrency cap this fix
      // does not change.
      maxConcurrency: 200,
      deferRunningUntilLaunch: true,
    });
    for (let i = 0; i < BURST_TASK_COUNT; i += 1) {
      orchestrator.loadPlan(singleTaskWorkflow(`burst-wf-${i}`));
    }
    return { orchestrator, persistence };
  }

  // Measured on this machine (in-memory SQLite, no other load): unbounded
  // startExecution() over this exact 150-task burst takes ~2.2s; capped at
  // { limit: 32 } (LaunchDispatcher's default maxLeasesPerPoll) takes ~0.7s.
  // Keep the fixed-path guard relative to an uncapped baseline so the test
  // remains meaningful under loaded workspace runs.

  it(
    'stays bounded: unbounded startExecution() over a 150-task ready burst avoids per-task reloads',
    async () => {
      const { orchestrator, persistence } = await buildBurstOrchestrator();
      const bulkTaskLoadSpy = vi.spyOn(persistence, 'loadTasksForWorkflows');
      const perWorkflowTaskLoadSpy = vi.spyOn(persistence, 'loadTasks');

      const started = orchestrator.startExecution();

      expect(started.length).toBe(BURST_TASK_COUNT);
      // Before the refreshFromDb() N+1 fix, this measured ~2.2s (see the
      // file-level comment) because each ready task triggered another DB
      // refresh. Assert the read shape directly so loaded CI hosts do not
      // turn the regression guard into a wall-clock race.
      expect(bulkTaskLoadSpy.mock.calls.length).toBeLessThanOrEqual(5);
      expect(perWorkflowTaskLoadSpy).not.toHaveBeenCalled();
    },
    30_000,
  );

  it(
    'keeps capped startExecution({ limit: 32 }) bounded over the same 150-task ready burst',
    async () => {
      const { orchestrator, persistence } = await buildBurstOrchestrator();
      const bulkTaskLoadSpy = vi.spyOn(persistence, 'loadTasksForWorkflows');
      const perWorkflowTaskLoadSpy = vi.spyOn(persistence, 'loadTasks');

      // 32 matches LaunchDispatcher's default maxLeasesPerPoll
      // (packages/app/src/launch-dispatcher.ts:106) — this is the exact
      // call topUpReadyLaunches() now makes.
      const started = orchestrator.startExecution({ limit: 32 });

      expect(started.length).toBe(32);
      expect(bulkTaskLoadSpy.mock.calls.length).toBeLessThanOrEqual(5);
      expect(perWorkflowTaskLoadSpy).not.toHaveBeenCalled();
    },
    180_000,
  );
});

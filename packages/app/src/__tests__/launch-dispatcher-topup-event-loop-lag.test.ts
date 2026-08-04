import { afterEach, describe, expect, it } from 'vitest';
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
  async function buildBurstOrchestrator(): Promise<Orchestrator> {
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
    return orchestrator;
  }

  it(
    'reproduces the unbounded pre-fix shape: startExecution() processes the whole ready burst',
    async () => {
      const orchestrator = await buildBurstOrchestrator();
      const started = orchestrator.startExecution();
      expect(started.length).toBe(BURST_TASK_COUNT);
    },
    30_000,
  );

  it(
    'caps one poll to 32 starts and leaves the rest for later polls',
    async () => {
      const orchestrator = await buildBurstOrchestrator();
      // 32 matches LaunchDispatcher's default maxLeasesPerPoll
      // (packages/app/src/launch-dispatcher.ts:106) — this is the exact
      // call topUpReadyLaunches() now makes.
      const firstPoll = orchestrator.startExecution({ limit: 32 });
      expect(firstPoll.length).toBe(32);

      const secondPoll = orchestrator.startExecution({ limit: 32 });
      expect(secondPoll.length).toBe(32);
      expect(new Set([...firstPoll, ...secondPoll].map((task) => task.id)).size).toBe(64);
    },
    30_000,
  );
});

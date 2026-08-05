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

/**
 * Measures the max gap between consecutive probe ticks while `fn()` runs,
 * matching the renderer event-loop-lag probe idiom already used in
 * packages/ui/src/App.tsx:1497-1523 (setInterval + performance.now(),
 * tracking now - previousTickAt, reporting the max observed delta).
 */
async function measureMaxSyncGapMs(fn: () => void, probeMs = 4): Promise<number> {
  let maxGapMs = 0;
  let previousTickAt = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    maxGapMs = Math.max(maxGapMs, now - previousTickAt);
    previousTickAt = now;
  }, probeMs);
  try {
    fn();
  } finally {
    // Let a pending probe tick land so the gap spanning the sync call is captured.
    await new Promise((resolve) => setTimeout(resolve, probeMs * 4));
    clearInterval(timer);
  }
  return maxGapMs;
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

  // Measured on this machine (in-memory SQLite, no other load): unbounded
  // startExecution() over this exact 150-task burst takes ~2.2s; capped at
  // { limit: 32 } (LaunchDispatcher's default maxLeasesPerPoll) takes ~0.7s.
  // Keep the fixed-path guard relative to an uncapped baseline so the test
  // remains meaningful under loaded workspace runs.

  it(
    'reproduces multi-hundred-ms blocking: unbounded startExecution() over a 150-task ready burst',
    async () => {
      const orchestrator = await buildBurstOrchestrator();
      const maxGapMs = await measureMaxSyncGapMs(() => {
        const started = orchestrator.startExecution();
        expect(started.length).toBe(BURST_TASK_COUNT);
      });
      expect(
        maxGapMs,
        `maxGapMs=${maxGapMs} (uncapped startExecution over ${BURST_TASK_COUNT}-task burst)`,
      ).toBeGreaterThan(500);
    },
    30_000,
  );

  it(
    'stays meaningfully faster: capped startExecution({ limit: 32 }) over the same 150-task ready burst',
    async () => {
      const uncappedOrchestrator = await buildBurstOrchestrator();
      const uncappedMaxGapMs = await measureMaxSyncGapMs(() => {
        const started = uncappedOrchestrator.startExecution();
        expect(started.length).toBe(BURST_TASK_COUNT);
      });

      const cappedOrchestrator = await buildBurstOrchestrator();
      const cappedMaxGapMs = await measureMaxSyncGapMs(() => {
        // 32 matches LaunchDispatcher's default maxLeasesPerPoll
        // (packages/app/src/launch-dispatcher.ts:106) — this is the exact
        // call topUpReadyLaunches() now makes.
        const started = cappedOrchestrator.startExecution({ limit: 32 });
        expect(started.length).toBe(32);
      });
      expect(
        cappedMaxGapMs,
        `cappedMaxGapMs=${cappedMaxGapMs}, uncappedMaxGapMs=${uncappedMaxGapMs} (${BURST_TASK_COUNT}-task burst)`,
      ).toBeLessThan(uncappedMaxGapMs);
    },
    30_000,
  );
});

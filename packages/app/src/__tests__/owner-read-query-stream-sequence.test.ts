import { describe, it, expect, vi } from 'vitest';
import { answerOwnerReadQuery, buildOwnerReadQueryHandlers } from '../owner-read-query.js';
import { createTaskDeltaStreamSequence } from '../task-delta-stream-sequence.js';

// Documents a real, permanent, and INTENTIONAL characteristic surfaced
// while root-causing a live infinite-resync-loop incident: the headless
// standalone owner has no renderer/window of its own, so it has no local
// task-delta-stream counter to report (main.ts, `getStreamSequence: () => 0`
// on the standalone `headless.query` handler) — that counter is a
// per-GUI-process delivery count (task-delta-stream-sequence.ts), which
// doesn't exist for a window-less process. `task-graph-refresh` and plain
// `tasks` reads both route through the same `getTasksSnapshot()` handler
// (owner-read-query.ts:243-251), so this 0 is what standalone always
// answers.
//
// Today, resolveRefreshTaskGraphSnapshot (refresh-task-graph.ts) blindly
// trusts this value for delegated reads, handing callers a number from a
// different process's counter that could never satisfy their own
// gap-detection watermark (see refresh-task-graph.test.ts, "uses the
// caller's own local streamSequence..." — currently `it.fails`, fixed in
// the next slice of this stack). Once that lands, this 0 answer becomes
// provably inert instead of silently wrong. This test guards the stub's
// own behavior either way.
describe('owner-read-query: standalone getStreamSequence stub stays inert', () => {
  it('task-graph-refresh answers streamSequence 0 even after real deltas have been stamped past 0', () => {
    // The real, single, shared counter every live delta gets stamped with —
    // exactly what main.ts:2234 creates and main.ts:2235 exposes as
    // getTaskDeltaStreamSequence for the (unused-by-standalone) real path.
    const taskDeltaStream = createTaskDeltaStreamSequence();
    for (let i = 0; i < 7285; i += 1) {
      taskDeltaStream.stamp({ type: 'updated', taskId: 't1', changes: {} } as never);
    }
    expect(taskDeltaStream.current()).toBe(7285); // matches the live "actual" seen in ~/.invoker/invoker.log

    // This mirrors main.ts:1826-1832's ACTUAL standalone wiring verbatim —
    // including the hardcoded `getStreamSequence: () => 0` — deliberately
    // NOT wired to `taskDeltaStream` above, exactly as shipped today.
    const handlers = buildOwnerReadQueryHandlers({
      ownerModeLabel: 'standalone',
      getUiPerfStats: () => ({}),
      resetUiPerfStats: () => {},
      getStreamSequence: () => 0,
      getWorkerStatus: () => ({ generatedAt: 'now', workers: [] }),
      getWorkers: () => ({ generatedAt: 'now', workers: [] }),
      resolveInvokerHomeRoot: () => '/home',
      orchestrator: {
        getQueueStatus: () => ({}),
        getWorkflowStatus: () => ({}),
        getAllTasks: () => [{ id: 't1' }],
        getMergeNode: () => undefined,
        syncAllFromDb: vi.fn(),
        syncFromDb: vi.fn(),
      } as never,
      persistence: { listWorkflows: () => [] } as never,
      getActionGraphSnapshot: () => ({}),
      getPlanningChatSession: () => ({}),
    });

    const refreshReply = answerOwnerReadQuery({ kind: 'task-graph-refresh' }, handlers) as { streamSequence: number };

    // The standalone owner's raw answer is still 0 here, even with 7285 real
    // deltas stamped elsewhere — expected, since this process has no
    // renderer-local counter of its own. resolveRefreshTaskGraphSnapshot no
    // longer trusts this value for delegated reads (see
    // refresh-task-graph.test.ts), so this is now provably harmless.
    expect(refreshReply.streamSequence).toBe(0);
    expect(refreshReply.streamSequence).toBeLessThan(taskDeltaStream.current());
  });
});

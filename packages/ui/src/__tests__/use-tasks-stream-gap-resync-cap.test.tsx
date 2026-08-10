import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useTasks } from '../hooks/useTasks.js';
import { makeUITask } from './helpers/mock-invoker.js';

// PROOF for a live incident: "Error invoking remote method
// 'invoker:planning-chat-send': TransportError: Request on channel
// headless.gui-mutation timed out after 7200000ms" and a
// ui_delta_stream_gap_detected storm observed in ~/.invoker/invoker.log
// (2367 occurrences over 52 min, expected frozen while actual climbed past
// 7000).
//
// Server root cause (already fixed in an earlier slice of this stack,
// packages/app/src/refresh-task-graph.ts): a delegated resync used to trust
// the remote owner's own streamSequence, which belongs to a different
// process's counter (or the headless standalone owner's inert stub) and
// could never satisfy the caller's own watermark.
//
// This slice covers the client-side half, as defense-in-depth: even if
// some future resync reply still doesn't close the gap, useTasks must not
// retry forever. Today it has no cap, so this assertion fails by design
// (it.fails) -- the next slice adds the cap and flips this to a normal
// `it`.
describe('useTasks stream-gap resync cap', () => {
  it.fails('stops auto-retrying after MAX_CONSECUTIVE_RESYNC_FAILURES round trips and recovers instead of looping forever', async () => {
    const t1 = makeUITask({ id: 't1', status: 'pending' });

    let handler: ((event: unknown) => void) | undefined;
    const STUCK_SEQ = 5; // simulates a resync reply that never advances past 5

    (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__ = {
      tasks: [t1],
      workflows: [],
      streamSequence: STUCK_SEQ,
    };

    const refreshTaskGraphMock = vi.fn(async () => {
      queueMicrotask(() => {
        handler?.({
          type: 'snapshot',
          tasks: [t1],
          workflows: [],
          reason: 'test-resync-stuck',
          streamSequence: STUCK_SEQ,
        });
      });
    });

    const reportUiPerfMock = vi.fn();
    const onTaskGraphEventMock = vi.fn((cb: (event: unknown) => void) => {
      handler = cb;
      return () => { handler = undefined; };
    });

    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getTasks: vi.fn(async () => ({ tasks: [t1], workflows: [], streamSequence: STUCK_SEQ })),
      refreshTaskGraph: refreshTaskGraphMock,
      reportUiPerf: reportUiPerfMock,
      onTaskGraphEvent: onTaskGraphEventMock,
      onWorkflowsChanged: vi.fn(() => () => {}),
      checkPrStatuses: vi.fn(async () => {}),
    };

    renderHook(() => useTasks());
    await waitFor(() => expect(onTaskGraphEventMock).toHaveBeenCalledTimes(1));

    // 4 consecutive real deltas, none of which the (broken) resync ever
    // catches up to: 3 round trips (the cap), then a 4th that must give up
    // instead of retrying a 4th time.
    for (const seq of [STUCK_SEQ + 2, STUCK_SEQ + 3, STUCK_SEQ + 4, STUCK_SEQ + 5]) {
      await act(async () => {
        handler?.({
          type: 'delta',
          delta: { type: 'updated', taskId: 't1', changes: { status: 'running' }, taskStateVersion: 2, previousTaskStateVersion: 1, streamSequence: seq },
          workflowRollups: [],
        });
        // >100ms: the task-graph-event batch pipeline (flushMs: 100) must
        // flush and apply the pushed snapshot before the next delta arrives.
        await new Promise((resolve) => setTimeout(resolve, 150));
      });
    }

    // Capped at 3 — not a 4th call for the 4th gap.
    expect(refreshTaskGraphMock).toHaveBeenCalledTimes(3);

    const exhaustedReports = reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_resync_exhausted');
    expect(exhaustedReports).toHaveLength(1);
    expect(exhaustedReports[0][1]).toMatchObject({ attempts: 4 });

    // Recovered: the 4th delta's data made it through instead of the UI
    // staying stuck on stale data forever.
    await waitFor(() => {
      expect(reportUiPerfMock.mock.calls.filter((c) => c[0] === 'ui_delta_stream_gap_detected')).toHaveLength(4);
    });

    delete (window as unknown as { invoker?: unknown }).invoker;
    delete (window as unknown as { __INVOKER_BOOTSTRAP__?: unknown }).__INVOKER_BOOTSTRAP__;
  });
});

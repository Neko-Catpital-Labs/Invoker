import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { createMockInvoker, makePlanningSessionSummary, type MockInvoker } from './helpers/mock-invoker.js';

vi.mock('@xyflow/react', async () => {
  const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
  return createReactFlowMock();
});

const { App } = await import('../App.js');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((innerResolve) => {
    resolve = innerResolve;
  });
  return { promise, resolve };
}

describe('planning poll overlap repro', () => {
  let mock: MockInvoker;

  beforeEach(() => {
    mock = createMockInvoker();
    mock.install();
  });

  afterEach(() => {
    mock.cleanup();
  });

  it('skips a poll tick while the previous refresh is still in flight', async () => {
    const pending: Array<ReturnType<typeof deferred<{ ok: boolean; sessions: ReturnType<typeof makePlanningSessionSummary>[] }>>> = [];
    let callCount = 0;
    const busySessions = [
      makePlanningSessionSummary({
        id: 'busy-chat',
        title: 'Busy chat',
        status: 'still_discussing',
        draftPlanAvailable: false,
        draftPlanSummary: undefined,
        draftPlanText: undefined,
        activeTurnId: 'turn-live',
        activeTurnStatus: 'running',
      }),
    ];
    mock.api.planningChatList = vi.fn(() => {
      callCount += 1;
      // Mount fires two independent hydrate calls (a legacy startup hydrate
      // and refreshPlanningSessionsNow's own mount effect) before the busy
      // poll's interval ever attaches; both settle with the busy session so
      // anyPlanningSessionBusy flips true and the interval starts.
      if (callCount <= 2) {
        return Promise.resolve({ ok: true, sessions: busySessions });
      }
      const d = deferred<{ ok: boolean; sessions: ReturnType<typeof makePlanningSessionSummary>[] }>();
      pending.push(d);
      return d.promise;
    }) as any;

    vi.useFakeTimers();
    try {
      render(<App />);
      // Flush the two mount-time hydrate calls (microtasks only, no timers
      // involved) so the busy session lands and the poll interval attaches.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(callCount).toBe(2);

      // First poll tick starts the poll's own refresh, which we leave in flight.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5100);
      });
      expect(callCount).toBe(3);
      expect(pending).toHaveLength(1);

      // A second tick fires while the poll's refresh is still pending.
      // With the in-flight guard, this tick must be skipped.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(callCount).toBe(3);

      // Resolving the in-flight refresh clears the guard; the next tick
      // is free to start a new refresh again.
      await act(async () => {
        pending[0]!.resolve({ ok: true, sessions: [] });
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(callCount).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});

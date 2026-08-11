import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useQueueStatus } from '../hooks/useQueueStatus.js';
import type { QueueStatus, TaskGraphEvent } from '../types.js';

function makeQueueStatus(activeExecutionCount: number): QueueStatus {
  return {
    maxConcurrency: 1,
    runningCount: activeExecutionCount,
    activeExecutionCount,
    launchingCount: 0,
    running: activeExecutionCount > 0
      ? [{ taskId: 'wf-1/a', description: 'task a' }]
      : [],
    queued: [],
  };
}

describe('useQueueStatus', () => {
  let taskGraphHandler: ((event: TaskGraphEvent) => void) | undefined;

  beforeEach(() => {
    taskGraphHandler = undefined;
    (window as unknown as { invoker: Record<string, unknown> }).invoker = {
      getQueueStatus: vi
        .fn()
        .mockResolvedValueOnce(makeQueueStatus(0))
        .mockResolvedValue(makeQueueStatus(1)),
      onTaskGraphEvent: vi.fn((cb: (event: TaskGraphEvent) => void) => {
        taskGraphHandler = cb;
        return () => {};
      }),
    };
  });

  afterEach(() => {
    delete (window as unknown as { invoker?: unknown }).invoker;
  });

  it('force-refreshes queue status when task graph status deltas arrive', async () => {
    const { result } = renderHook(() => useQueueStatus(5000));

    await waitFor(() => expect(result.current?.activeExecutionCount).toBe(0));

    act(() => {
      taskGraphHandler?.({
        type: 'delta',
        delta: {
          type: 'updated',
          taskId: 'wf-1/a',
          changes: { status: 'running' },
          previousTaskStateVersion: 1,
          taskStateVersion: 2,
        },
        workflowRollups: [],
      });
    });

    await waitFor(() => expect(result.current?.activeExecutionCount).toBe(1));
    expect(window.invoker.getQueueStatus).toHaveBeenLastCalledWith({ refresh: true });
  });
});

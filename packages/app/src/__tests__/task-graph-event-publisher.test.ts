import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTaskGraphEventPublisher } from '../task-graph-event-publisher.js';

function createPublisher() {
  const send = vi.fn();
  const publisher = createTaskGraphEventPublisher({
    getMainWindow: () => ({
      isDestroyed: () => false,
      webContents: { send },
    }) as never,
    isUiInteractive: () => true,
    stampDelta: (delta) => delta,
  });
  return { publisher, send };
}

describe('createTaskGraphEventPublisher', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches non-status deltas on the normal flush timer', () => {
    vi.useFakeTimers();
    const { publisher, send } = createPublisher();

    publisher.publishDelta({
      type: 'updated',
      taskId: 'task-1',
      changes: { execution: { phase: 'executing' } },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    }, []);

    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(24);
    expect(send).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flushes status deltas immediately', () => {
    vi.useFakeTimers();
    const { publisher, send } = createPublisher();

    publisher.publishDelta({
      type: 'updated',
      taskId: 'task-1',
      changes: { status: 'running' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    }, []);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(
      'invoker:task-graph-event',
      expect.objectContaining({
        type: 'delta',
        delta: expect.objectContaining({
          taskId: 'task-1',
          changes: { status: 'running' },
        }),
      }),
    );
  });
});

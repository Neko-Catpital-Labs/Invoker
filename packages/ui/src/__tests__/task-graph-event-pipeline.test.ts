import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTaskGraphEventPipeline } from '../lib/task-graph-event-pipeline.js';
import type { TaskGraphEvent, TaskState } from '../types.js';

function makeTask(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
  };
}

describe('task-graph-event-pipeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches delta and snapshot events in FIFO order', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskGraphEvent[]) => void>();
    const pipeline = createTaskGraphEventPipeline({ flushMs: 100, onBatch });
    const deltaEvent: TaskGraphEvent = { type: 'delta', delta: { type: 'created', task: makeTask('t1') } };
    const snapshotEvent: TaskGraphEvent = {
      type: 'snapshot',
      tasks: [makeTask('t2')],
      workflows: [],
      reason: 'test',
      streamSequence: 3,
    };

    pipeline.push(deltaEvent);
    pipeline.push(snapshotEvent);
    vi.advanceTimersByTime(100);

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual([deltaEvent, snapshotEvent]);

    pipeline.dispose();
  });

  it('clear drops pending graph events', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskGraphEvent[]) => void>();
    const pipeline = createTaskGraphEventPipeline({ flushMs: 100, onBatch });

    pipeline.push({ type: 'delta', delta: { type: 'created', task: makeTask('t1') } });
    pipeline.clear();
    vi.advanceTimersByTime(100);

    expect(onBatch).not.toHaveBeenCalled();

    pipeline.dispose();
  });
});

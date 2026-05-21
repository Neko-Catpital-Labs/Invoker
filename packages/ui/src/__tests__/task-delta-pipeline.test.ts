import { describe, it, expect, vi, afterEach } from 'vitest';
import { createTaskDeltaPipeline } from '../lib/task-delta-pipeline.js';
import type { TaskDelta } from '../types.js';

describe('task-delta-pipeline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('batches deltas into a single flush window', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskDelta[]) => void>();
    const pipeline = createTaskDeltaPipeline({ flushMs: 100, onBatch });

    const d1: TaskDelta = {
      type: 'created',
      task: {
        id: 't1',
        description: 'one',
        status: 'pending',
        dependencies: [],
        createdAt: new Date('2025-01-01'),
        config: {},
        execution: {},
      },
    };
    const d2: TaskDelta = {
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
    };

    pipeline.push(d1);
    pipeline.push(d2);
    vi.advanceTimersByTime(99);
    expect(onBatch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual([d1, d2]);

    pipeline.dispose();
  });

  it('preserves FIFO order in batch emission', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskDelta[]) => void>();
    const pipeline = createTaskDeltaPipeline({ flushMs: 100, onBatch });

    const deltas: TaskDelta[] = [
      {
        type: 'created',
        task: {
          id: 'a',
          description: 'a',
          status: 'pending',
          dependencies: [],
          createdAt: new Date('2025-01-01'),
          config: {},
          execution: {},
        },
      },
      { type: 'removed', taskId: 'a' },
      {
        type: 'created',
        task: {
          id: 'b',
          description: 'b',
          status: 'pending',
          dependencies: [],
          createdAt: new Date('2025-01-01'),
          config: {},
          execution: {},
        },
      },
    ];

    for (const d of deltas) pipeline.push(d);
    vi.advanceTimersByTime(100);

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual(deltas);

    pipeline.dispose();
  });

  it('flushNow emits pending queue immediately', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskDelta[]) => void>();
    const pipeline = createTaskDeltaPipeline({ flushMs: 100, onBatch });

    const delta: TaskDelta = {
      type: 'created',
      task: {
        id: 'x',
        description: 'x',
        status: 'pending',
        dependencies: [],
        createdAt: new Date('2025-01-01'),
        config: {},
        execution: {},
      },
    };

    pipeline.push(delta);
    pipeline.flushNow();

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0]).toEqual([delta]);

    // No second emit from the timer.
    vi.advanceTimersByTime(100);
    expect(onBatch).toHaveBeenCalledTimes(1);

    pipeline.dispose();
  });

  it('chunks large queues across flush windows', () => {
    vi.useFakeTimers();
    const onBatch = vi.fn<(batch: TaskDelta[]) => void>();
    const onLargeBatch = vi.fn();
    const pipeline = createTaskDeltaPipeline({
      flushMs: 100,
      maxBatchSize: 2,
      onBatch,
      onLargeBatch,
    });

    const deltas: TaskDelta[] = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      type: 'created',
      task: {
        id,
        description: id,
        status: 'pending',
        dependencies: [],
        createdAt: new Date('2025-01-01'),
        config: {},
        execution: {},
      },
    }));

    for (const delta of deltas) pipeline.push(delta);
    vi.advanceTimersByTime(100);

    expect(onBatch).toHaveBeenCalledTimes(1);
    expect(onBatch.mock.calls[0][0].map((delta) => delta.type === 'created' ? delta.task.id : 'other')).toEqual(['a', 'b']);
    expect(onLargeBatch).toHaveBeenCalledWith({ batchSize: 2, remaining: 3 });

    vi.advanceTimersByTime(100);
    expect(onBatch.mock.calls[1][0].map((delta) => delta.type === 'created' ? delta.task.id : 'other')).toEqual(['c', 'd']);

    vi.advanceTimersByTime(100);
    expect(onBatch.mock.calls[2][0].map((delta) => delta.type === 'created' ? delta.task.id : 'other')).toEqual(['e']);

    pipeline.dispose();
  });
});

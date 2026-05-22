import type { TaskDelta } from '../types.js';

export interface TaskDeltaPipeline {
  push: (delta: TaskDelta) => void;
  flushNow: () => void;
  clear: () => void;
  dispose: () => void;
}

export interface CreateTaskDeltaPipelineOptions {
  flushMs?: number;
  maxBatchSize?: number;
  onBatch: (batch: TaskDelta[]) => void;
  onLargeBatch?: (stats: { batchSize: number; remaining: number }) => void;
}

/**
 * UI-local FIFO batching pipeline for task deltas.
 *
 * This keeps batching concerns isolated behind a tiny interface so we can swap
 * implementation details later without touching hook/business logic.
 *
 * NOTE: We are considering using RxJS at some point for richer stream
 * composition (buffering, throttling, multi-source fan-in). This module is the
 * current in-house boundary for that future migration.
 */
export function createTaskDeltaPipeline(
  options: CreateTaskDeltaPipelineOptions,
): TaskDeltaPipeline {
  const flushMs = options.flushMs ?? 100;
  const maxBatchSize = options.maxBatchSize ?? 250;
  let queue: TaskDelta[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = (): void => {
    if (queue.length === 0) return;
    const batchSize = Math.min(maxBatchSize, queue.length);
    const batch = queue.splice(0, batchSize);
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (queue.length > 0) {
      options.onLargeBatch?.({ batchSize: batch.length, remaining: queue.length });
      schedule();
    }
    options.onBatch(batch);
  };

  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      flushNow();
    }, flushMs);
  };

  return {
    push(delta: TaskDelta): void {
      queue.push(delta);
      schedule();
    },
    flushNow,
    clear(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queue = [];
    },
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queue = [];
    },
  };
}

import type { TaskDelta } from '../types.js';

export interface TaskDeltaPipeline {
  push: (delta: TaskDelta) => void;
  flushNow: () => void;
  dispose: () => void;
}

export interface CreateTaskDeltaPipelineOptions {
  flushMs?: number;
  onBatch: (batch: TaskDelta[]) => void;
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
  let queue: TaskDelta[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flushNow = (): void => {
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    if (timer) {
      clearTimeout(timer);
      timer = null;
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
    dispose(): void {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      queue = [];
    },
  };
}

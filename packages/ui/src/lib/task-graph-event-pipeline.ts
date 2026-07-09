import { merge, queueScheduler, Subject, Subscription, timer } from 'rxjs';
import { observeOn, takeUntil } from 'rxjs/operators';
import type { TaskGraphEvent } from '../types.js';

export interface TaskGraphEventPipeline {
  push: (event: TaskGraphEvent) => void;
  flushNow: () => void;
  clear: () => void;
  dispose: () => void;
}

export interface CreateTaskGraphEventPipelineOptions {
  flushMs?: number;
  maxBatchSize?: number;
  onBatch: (batch: TaskGraphEvent[]) => void;
  onLargeBatch?: (stats: { batchSize: number; remaining: number }) => void;
}

/**
 * UI-local FIFO batching pipeline for task graph events.
 *
 * A task graph event can be either an incremental task delta or a full graph
 * snapshot. Keeping both in one FIFO preserves reset ordering at the renderer
 * boundary.
 */
export function createTaskGraphEventPipeline(
  options: CreateTaskGraphEventPipelineOptions,
): TaskGraphEventPipeline {
  const flushMs = options.flushMs ?? 100;
  const maxBatchSize = options.maxBatchSize ?? 250;
  const inboundEvents$ = new Subject<TaskGraphEvent>();
  const timerFlush$ = new Subject<void>();
  const flushNow$ = new Subject<void>();
  const clear$ = new Subject<void>();
  const dispose$ = new Subject<void>();
  const stopTimer$ = merge(flushNow$, clear$, dispose$);
  const flushRequests$ = merge(timerFlush$, flushNow$);
  const subscriptions = new Subscription();
  let queue: TaskGraphEvent[] = [];
  let timerSubscription: Subscription | null = null;
  let disposed = false;

  const cancelTimer = (): void => {
    timerSubscription?.unsubscribe();
    timerSubscription = null;
  };

  const schedule = (): void => {
    if (timerSubscription || disposed) return;
    timerSubscription = timer(flushMs).pipe(takeUntil(stopTimer$)).subscribe(() => {
      timerSubscription = null;
      timerFlush$.next();
    });
  };

  const flushQueue = (): void => {
    if (queue.length === 0) return;
    const batchSize = Math.min(maxBatchSize, queue.length);
    const batch = queue.splice(0, batchSize);
    cancelTimer();
    if (queue.length > 0) {
      options.onLargeBatch?.({ batchSize: batch.length, remaining: queue.length });
      schedule();
    }
    options.onBatch(batch);
  };

  subscriptions.add(
    inboundEvents$.pipe(observeOn(queueScheduler), takeUntil(dispose$)).subscribe((event) => {
      queue.push(event);
      schedule();
    }),
  );
  subscriptions.add(
    flushRequests$.pipe(takeUntil(dispose$)).subscribe(() => {
      flushQueue();
    }),
  );
  subscriptions.add(
    clear$.pipe(takeUntil(dispose$)).subscribe(() => {
      cancelTimer();
      queue = [];
    }),
  );
  subscriptions.add(
    dispose$.subscribe(() => {
      disposed = true;
      cancelTimer();
      queue = [];
    }),
  );

  return {
    push(event: TaskGraphEvent): void {
      if (disposed) return;
      inboundEvents$.next(event);
    },
    flushNow(): void {
      if (disposed) return;
      flushNow$.next();
    },
    clear(): void {
      if (disposed) return;
      clear$.next();
    },
    dispose(): void {
      if (disposed) return;
      dispose$.next();
      dispose$.complete();
      subscriptions.unsubscribe();
      inboundEvents$.complete();
      timerFlush$.complete();
      flushNow$.complete();
      clear$.complete();
    },
  };
}

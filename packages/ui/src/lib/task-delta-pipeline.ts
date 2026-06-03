import { merge, queueScheduler, Subject, Subscription, timer } from 'rxjs';
import { observeOn, takeUntil } from 'rxjs/operators';
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
 * This keeps batching concerns isolated behind a tiny interface while RxJS
 * owns the scheduling/control-stream plumbing at the renderer boundary.
 */
export function createTaskDeltaPipeline(
  options: CreateTaskDeltaPipelineOptions,
): TaskDeltaPipeline {
  const flushMs = options.flushMs ?? 100;
  const maxBatchSize = options.maxBatchSize ?? 250;
  const inboundDeltas$ = new Subject<TaskDelta>();
  const timerFlush$ = new Subject<void>();
  const flushNow$ = new Subject<void>();
  const clear$ = new Subject<void>();
  const dispose$ = new Subject<void>();
  const stopTimer$ = merge(flushNow$, clear$, dispose$);
  const flushRequests$ = merge(timerFlush$, flushNow$);
  const subscriptions = new Subscription();
  let queue: TaskDelta[] = [];
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
    inboundDeltas$.pipe(observeOn(queueScheduler), takeUntil(dispose$)).subscribe((delta) => {
      queue.push(delta);
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
    push(delta: TaskDelta): void {
      if (disposed) return;
      inboundDeltas$.next(delta);
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
      subscriptions.unsubscribe();
      inboundDeltas$.complete();
      timerFlush$.complete();
      flushNow$.complete();
      clear$.complete();
      dispose$.complete();
    },
  };
}

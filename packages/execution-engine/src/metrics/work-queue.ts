import { MetricRegistry } from './metric-registry.js';

export interface WorkQueueEntry<TPayload = unknown> {
  readonly key: string;
  readonly payload: TPayload;
}

export interface WorkQueueSnapshot {
  readonly name: string;
  readonly queued: number;
  readonly processing: number;
  readonly complete: number;
  readonly failed: number;
  readonly added: number;
  readonly deduped: number;
  readonly unaccounted: number;
}

export interface WorkQueueOptions {
  readonly name: string;
  readonly registry?: MetricRegistry;
  readonly nowMs?: () => number;
}

interface QueueItem<TPayload> {
  readonly key: string;
  readonly payload: TPayload;
  readonly enqueuedAtMs: number;
}

interface ProcessingItem<TPayload> {
  readonly key: string;
  readonly payload: TPayload;
  readonly startedAtMs: number;
}

const WORKQUEUE_HELP = {
  adds: 'Total number of workqueue adds handled by name.',
  retries: 'Total number of workqueue retries handled by name.',
  depth: 'Current depth of the named workqueue.',
  queueDuration: 'Seconds workqueue items spent waiting before processing.',
  workDuration: 'Seconds workqueue items spent processing.',
  unfinished: 'Seconds of work currently in flight for the named workqueue.',
  longest: 'Longest currently running processor for the named workqueue.',
  completeness: 'Current workqueue accounting buckets by state.',
} as const;

export class WorkQueue<TPayload = unknown> {
  readonly registry: MetricRegistry;

  private readonly name: string;
  private readonly nowMs: () => number;
  private readonly queued = new Map<string, QueueItem<TPayload>>();
  private readonly queueOrder: string[] = [];
  private readonly processing = new Map<string, ProcessingItem<TPayload>>();
  private completeCount = 0;
  private failedCount = 0;
  private addedCount = 0;
  private dedupedCount = 0;

  constructor(options: WorkQueueOptions) {
    this.name = options.name;
    this.registry = options.registry ?? new MetricRegistry();
    this.nowMs = options.nowMs ?? Date.now;
    this.updateGauges();
  }

  enqueue(key: string, payload: TPayload): boolean {
    if (this.queued.has(key) || this.processing.has(key)) {
      this.dedupedCount += 1;
      this.updateGauges();
      return false;
    }

    this.queued.set(key, { key, payload, enqueuedAtMs: this.nowMs() });
    this.queueOrder.push(key);
    this.addedCount += 1;
    this.registry.incrementCounter(
      'workqueue_adds_total',
      { name: this.name },
      1,
      WORKQUEUE_HELP.adds,
    );
    this.updateGauges();
    return true;
  }

  retry(key: string, payload: TPayload): boolean {
    this.registry.incrementCounter(
      'workqueue_retries_total',
      { name: this.name },
      1,
      WORKQUEUE_HELP.retries,
    );
    return this.enqueue(key, payload);
  }

  take(): WorkQueueEntry<TPayload> | undefined {
    while (this.queueOrder.length > 0) {
      const key = this.queueOrder.shift()!;
      const item = this.queued.get(key);
      if (!item) continue;

      this.queued.delete(key);
      const nowMs = this.nowMs();
      this.processing.set(key, { key, payload: item.payload, startedAtMs: nowMs });
      this.registry.observeHistogram(
        'workqueue_queue_duration_seconds',
        { name: this.name },
        Math.max(0, nowMs - item.enqueuedAtMs) / 1000,
        WORKQUEUE_HELP.queueDuration,
      );
      this.updateGauges(nowMs);
      return { key: item.key, payload: item.payload };
    }

    this.updateGauges();
    return undefined;
  }

  complete(key: string): boolean {
    return this.finish(key, 'complete');
  }

  fail(key: string): boolean {
    return this.finish(key, 'failed');
  }

  snapshot(): WorkQueueSnapshot {
    return this.buildSnapshot();
  }

  renderPrometheusText(): string {
    this.updateGauges();
    return this.registry.renderPrometheusText();
  }

  private finish(key: string, outcome: 'complete' | 'failed'): boolean {
    const item = this.processing.get(key);
    if (!item) {
      this.updateGauges();
      return false;
    }

    const nowMs = this.nowMs();
    this.processing.delete(key);
    if (outcome === 'complete') {
      this.completeCount += 1;
    } else {
      this.failedCount += 1;
    }
    this.registry.observeHistogram(
      'workqueue_work_duration_seconds',
      { name: this.name },
      Math.max(0, nowMs - item.startedAtMs) / 1000,
      WORKQUEUE_HELP.workDuration,
    );
    this.updateGauges(nowMs);
    return true;
  }

  private buildSnapshot(): WorkQueueSnapshot {
    const accounted = this.queued.size + this.processing.size + this.completeCount + this.failedCount;
    return {
      name: this.name,
      queued: this.queued.size,
      processing: this.processing.size,
      complete: this.completeCount,
      failed: this.failedCount,
      added: this.addedCount,
      deduped: this.dedupedCount,
      unaccounted: this.addedCount - accounted,
    };
  }

  private updateGauges(nowMs = this.nowMs()): void {
    this.registry.setGauge(
      'workqueue_depth',
      { name: this.name },
      this.queued.size,
      WORKQUEUE_HELP.depth,
    );

    let unfinishedSeconds = 0;
    let longestRunningSeconds = 0;
    for (const item of this.processing.values()) {
      const seconds = Math.max(0, nowMs - item.startedAtMs) / 1000;
      unfinishedSeconds += seconds;
      longestRunningSeconds = Math.max(longestRunningSeconds, seconds);
    }

    this.registry.setGauge(
      'workqueue_unfinished_work_seconds',
      { name: this.name },
      unfinishedSeconds,
      WORKQUEUE_HELP.unfinished,
    );
    this.registry.setGauge(
      'workqueue_longest_running_processor_seconds',
      { name: this.name },
      longestRunningSeconds,
      WORKQUEUE_HELP.longest,
    );

    const snapshot = this.buildSnapshot();
    for (const [state, value] of [
      ['queued', snapshot.queued],
      ['processing', snapshot.processing],
      ['complete', snapshot.complete],
      ['failed', snapshot.failed],
      ['unaccounted', snapshot.unaccounted],
    ] as const) {
      this.registry.setGauge(
        'workqueue_completeness',
        { name: this.name, state },
        value,
        WORKQUEUE_HELP.completeness,
      );
    }
  }
}


import { MetricRegistry, WorkQueue, type WorkQueueSnapshot } from '@invoker/execution-engine';

type MetricOperation = 'counter' | 'gauge' | 'histogram';

export type ChokeBoundaryQueueName = 'mutation' | 'launch' | 'heartbeat';
const CHOKE_QUEUE_NAMES: readonly ChokeBoundaryQueueName[] = ['mutation', 'launch', 'heartbeat'] as const;

export interface ChokeBoundaryMetricsOptions {
  registry?: MetricRegistry;
  nowMs?: () => number;
  onMetricError?: (operation: MetricOperation, error: unknown) => void;
}

export interface SqliteBoundaryMetricInfo {
  durationMs: number;
  outcome?: string;
  operation?: string;
}

export interface ChokeBoundarySnapshot {
  queues: Record<ChokeBoundaryQueueName, WorkQueueSnapshot>;
  prometheusText: string;
}

class NonFailingMetricRegistry extends MetricRegistry {
  constructor(
    private readonly delegate: MetricRegistry,
    private readonly onMetricError?: (operation: MetricOperation, error: unknown) => void,
  ) {
    super();
  }

  incrementCounter(...args: Parameters<MetricRegistry['incrementCounter']>): number {
    try {
      return this.delegate.incrementCounter(...args);
    } catch (err) {
      console.error('choke boundary metric counter failed', err);
      this.reportMetricError('counter', err);
      return 0;
    }
  }

  setGauge(...args: Parameters<MetricRegistry['setGauge']>): number {
    try {
      return this.delegate.setGauge(...args);
    } catch (err) {
      console.error('choke boundary metric gauge failed', err);
      this.reportMetricError('gauge', err);
      return 0;
    }
  }

  observeHistogram(...args: Parameters<MetricRegistry['observeHistogram']>): void {
    try {
      this.delegate.observeHistogram(...args);
    } catch (err) {
      console.error('choke boundary metric histogram failed', err);
      this.reportMetricError('histogram', err);
    }
  }

  getValue(...args: Parameters<MetricRegistry['getValue']>): number | undefined {
    return this.delegate.getValue(...args);
  }

  getHistogram(...args: Parameters<MetricRegistry['getHistogram']>): { count: number; sum: number } | undefined {
    return this.delegate.getHistogram(...args);
  }

  renderPrometheusText(): string {
    return this.delegate.renderPrometheusText();
  }

  private reportMetricError(operation: MetricOperation, error: unknown): void {
    try {
      this.onMetricError?.(operation, error);
    } catch (reportingFailure) {
      console.error(`choke boundary metric error callback failed for ${operation}`, error, reportingFailure);
    }
  }
}

export class ChokeBoundaryMetrics {
  readonly registry: MetricRegistry;

  private readonly nowMs: () => number;
  private readonly queues = new Map<ChokeBoundaryQueueName, WorkQueue<unknown>>();

  constructor(options: ChokeBoundaryMetricsOptions = {}) {
    this.registry = new NonFailingMetricRegistry(
      options.registry ?? new MetricRegistry(),
      options.onMetricError,
    );
    this.nowMs = options.nowMs ?? Date.now;
  }

  recordRequest(boundary: string, code: string, labels: Record<string, string> = {}): void {
    this.registry.incrementCounter(
      'choke_boundary_requests_total',
      { boundary, code, ...labels },
      1,
      'Total requests observed at named choke boundaries by result code.',
    );
  }

  recordQueueAccepted(queueName: ChokeBoundaryQueueName, key: string, payload: unknown = undefined): void {
    const queue = this.queueFor(queueName);
    if (!queue.enqueue(key, payload)) {
      return;
    }
    const entry = queue.take();
    if (!entry) {
      return;
    }
    queue.complete(entry.key);
  }

  recordQueueRejected(queueName: ChokeBoundaryQueueName, key: string, payload: unknown = undefined): void {
    const queue = this.queueFor(queueName);
    if (!queue.enqueue(key, payload)) {
      return;
    }
    const entry = queue.take();
    if (!entry) {
      return;
    }
    queue.fail(entry.key);
  }

  recordEventLoopLag(boundary: string, durationMs: number): void {
    this.registry.observeHistogram(
      'choke_boundary_event_loop_lag_seconds',
      { boundary },
      Math.max(0, durationMs) / 1000,
      'Observed synchronous event-loop occupancy at named choke boundaries.',
    );
  }

  recordSqliteTransaction(info: SqliteBoundaryMetricInfo): void {
    this.registry.observeHistogram(
      'choke_boundary_sqlite_transaction_seconds',
      { outcome: info.outcome ?? 'unknown' },
      Math.max(0, info.durationMs) / 1000,
      'Observed SQLite transaction duration by outcome.',
    );
  }

  recordSqliteBusyFailure(info: SqliteBoundaryMetricInfo): void {
    this.recordRequest('sqlite', 'busy', { operation: info.operation ?? 'unknown' });
    this.registry.observeHistogram(
      'choke_boundary_sqlite_busy_seconds',
      { operation: info.operation ?? 'unknown' },
      Math.max(0, info.durationMs) / 1000,
      'Observed SQLite busy failures at transaction boundaries.',
    );
  }

  getQueueSnapshot(queueName: ChokeBoundaryQueueName) {
    return this.queueFor(queueName).snapshot();
  }

  getSnapshot(): ChokeBoundarySnapshot {
    const queues = Object.fromEntries(
      CHOKE_QUEUE_NAMES.map((queueName) => [
        queueName,
        this.queues.get(queueName)?.snapshot() ?? zeroQueueSnapshot(queueName),
      ]),
    ) as Record<ChokeBoundaryQueueName, WorkQueueSnapshot>;
    return {
      queues,
      prometheusText: this.registry.renderPrometheusText(),
    };
  }

  private queueFor(queueName: ChokeBoundaryQueueName): WorkQueue<unknown> {
    let queue = this.queues.get(queueName);
    if (!queue) {
      queue = new WorkQueue({ name: `choke-${queueName}`, registry: this.registry, nowMs: this.nowMs });
      this.queues.set(queueName, queue);
    }
    return queue;
  }
}

function zeroQueueSnapshot(queueName: ChokeBoundaryQueueName): WorkQueueSnapshot {
  return {
    name: `choke-${queueName}`,
    queued: 0,
    processing: 0,
    complete: 0,
    failed: 0,
    added: 0,
    deduped: 0,
    unaccounted: 0,
  };
}

const defaultChokeBoundaryMetrics = new ChokeBoundaryMetrics();

export function getChokeBoundaryMetrics(): ChokeBoundaryMetrics {
  return defaultChokeBoundaryMetrics;
}

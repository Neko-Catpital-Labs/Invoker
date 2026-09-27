import { describe, expect, it, vi } from 'vitest';

import { MetricRegistry } from '../metrics/metric-registry.js';
import { createWorkerRuntime, type WorkerTickContext } from '../worker-runtime.js';

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

class ThrowingMetricRegistry extends MetricRegistry {
  incrementCounter(): number {
    throw new Error('counter failed');
  }

  setGauge(): number {
    throw new Error('gauge failed');
  }

  observeHistogram(): void {
    throw new Error('histogram failed');
  }
}

describe('WorkerRuntime WorkQueue', () => {
  it('drains the synthetic worker key one tick at a time and preserves coalesced follow-up work', async () => {
    const logger = makeLogger();
    const registry = new MetricRegistry();
    const releaseFirstTick = deferred();
    const secondTickStarted = deferred();
    const contexts: WorkerTickContext[] = [];
    const onTick = vi.fn(async (ctx: WorkerTickContext) => {
      contexts.push(ctx);
      if (contexts.length === 1) {
        await releaseFirstTick.promise;
      }
      if (contexts.length === 2) {
        secondTickStarted.resolve();
      }
    });

    const runtime = createWorkerRuntime({
      kind: 'test-queue',
      logger,
      onTick,
      intervalMs: 0,
      tickOnStart: false,
      installSignalHandlers: false,
      workQueueRegistry: registry,
      workQueueName: 'test-worker-runtime',
    });

    runtime.start();
    runtime.wake('wake');
    await Promise.resolve();
    runtime.wake('poll');

    expect(onTick).toHaveBeenCalledTimes(1);
    releaseFirstTick.resolve();
    await secondTickStarted.promise;
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });

    expect(onTick).toHaveBeenCalledTimes(2);
    expect(contexts.map((ctx) => ctx.reason)).toEqual(['wake', 'poll']);
    expect(contexts.map((ctx) => ctx.tickNumber)).toEqual([1, 2]);
    expect(registry.getValue('workqueue_adds_total', { name: 'test-worker-runtime' })).toBe(2);
    expect(registry.getValue('workqueue_completeness', { name: 'test-worker-runtime', state: 'complete' })).toBe(2);
    expect(registry.getHistogram('workqueue_work_duration_seconds', { name: 'test-worker-runtime' })?.count).toBe(2);

    await runtime.stop();
  });

  it('records failed work without changing tick failure propagation', async () => {
    const logger = makeLogger();
    const registry = new MetricRegistry();
    const runtime = createWorkerRuntime({
      kind: 'test-queue-failure',
      logger,
      onTick: vi.fn().mockRejectedValue(new Error('boom')),
      intervalMs: 0,
      tickOnStart: false,
      installSignalHandlers: false,
      workQueueRegistry: registry,
      workQueueName: 'test-worker-runtime-failure',
    });

    await expect(runtime.tick()).resolves.toBeUndefined();

    expect(runtime.health().consecutiveFailedTicks).toBe(1);
    expect(registry.getValue('workqueue_completeness', { name: 'test-worker-runtime-failure', state: 'failed' })).toBe(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('tick failed'), expect.anything());
  });

  it('does not let WorkQueue metric failures fail the tick', async () => {
    const logger = makeLogger();
    const onTick = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test-queue-metric-failure',
      logger,
      onTick,
      intervalMs: 0,
      tickOnStart: false,
      installSignalHandlers: false,
      workQueueRegistry: new ThrowingMetricRegistry(),
    });

    await expect(runtime.tick()).resolves.toBeUndefined();

    expect(onTick).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('work queue metric failed'),
      expect.anything(),
    );
  });
});

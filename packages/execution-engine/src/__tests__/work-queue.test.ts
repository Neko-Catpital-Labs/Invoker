import { describe, expect, it } from 'vitest';

import { MetricRegistry, WorkQueue } from '../metrics/index.js';

function clock(startMs = 0): { nowMs: () => number; advance: (ms: number) => void } {
  let now = startMs;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('WorkQueue metrics', () => {
  it('dedupes active keys while preserving queue order and depth', () => {
    const registry = new MetricRegistry();
    const queue = new WorkQueue<string>({ name: 'control-plane', registry, nowMs: () => 0 });

    expect(queue.enqueue('task-1', 'first')).toBe(true);
    expect(queue.enqueue('task-1', 'duplicate')).toBe(false);
    expect(queue.enqueue('task-2', 'second')).toBe(true);

    expect(queue.snapshot()).toMatchObject({
      queued: 2,
      processing: 0,
      added: 2,
      deduped: 1,
      unaccounted: 0,
    });
    expect(registry.getValue('workqueue_depth', { name: 'control-plane' })).toBe(2);
    expect(registry.getValue('workqueue_adds_total', { name: 'control-plane' })).toBe(2);
    expect(queue.take()).toEqual({ key: 'task-1', payload: 'first' });
    expect(queue.take()).toEqual({ key: 'task-2', payload: 'second' });
    expect(queue.take()).toBeUndefined();
  });

  it('keeps the completeness identity at every queue lifecycle state', () => {
    const time = clock();
    const registry = new MetricRegistry();
    const queue = new WorkQueue<string>({ name: 'workers', registry, nowMs: time.nowMs });

    queue.enqueue('task-1', 'first');
    queue.enqueue('task-2', 'second');
    time.advance(250);
    const first = queue.take();
    expect(first?.key).toBe('task-1');
    time.advance(500);
    expect(queue.complete('task-1')).toBe(true);

    const snapshot = queue.snapshot();
    expect(snapshot.added).toBe(snapshot.queued + snapshot.processing + snapshot.complete + snapshot.failed);
    expect(snapshot.unaccounted).toBe(0);
    expect(registry.getValue('workqueue_completeness', { name: 'workers', state: 'queued' })).toBe(1);
    expect(registry.getValue('workqueue_completeness', { name: 'workers', state: 'processing' })).toBe(0);
    expect(registry.getValue('workqueue_completeness', { name: 'workers', state: 'complete' })).toBe(1);
    expect(registry.getValue('workqueue_completeness', { name: 'workers', state: 'failed' })).toBe(0);
    expect(registry.getValue('workqueue_completeness', { name: 'workers', state: 'unaccounted' })).toBe(0);
    expect(registry.getHistogram('workqueue_queue_duration_seconds', { name: 'workers' })).toEqual({
      count: 1,
      sum: 0.25,
    });
    expect(registry.getHistogram('workqueue_work_duration_seconds', { name: 'workers' })).toEqual({
      count: 1,
      sum: 0.5,
    });
  });

  it('renders Prometheus text for the same Kubernetes workqueue and completeness numbers', () => {
    const time = clock(1_000);
    const queue = new WorkQueue<string>({ name: 'control-plane', nowMs: time.nowMs });

    queue.enqueue('task-1', 'first');
    time.advance(1_000);
    expect(queue.take()).toEqual({ key: 'task-1', payload: 'first' });
    time.advance(2_000);
    expect(queue.complete('task-1')).toBe(true);

    const text = queue.renderPrometheusText();
    expect(text).toContain('# TYPE workqueue_adds_total counter');
    expect(text).toContain('workqueue_adds_total{name="control-plane"} 1');
    expect(text).toContain('# TYPE workqueue_depth gauge');
    expect(text).toContain('workqueue_depth{name="control-plane"} 0');
    expect(text).toContain('workqueue_queue_duration_seconds_sum{name="control-plane"} 1');
    expect(text).toContain('workqueue_queue_duration_seconds_count{name="control-plane"} 1');
    expect(text).toContain('workqueue_work_duration_seconds_sum{name="control-plane"} 2');
    expect(text).toContain('workqueue_work_duration_seconds_count{name="control-plane"} 1');
    expect(text).toContain('workqueue_completeness{name="control-plane",state="complete"} 1');
    expect(text).toContain('workqueue_completeness{name="control-plane",state="unaccounted"} 0');
  });
});


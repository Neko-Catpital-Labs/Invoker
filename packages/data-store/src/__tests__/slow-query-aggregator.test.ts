import { describe, expect, it } from 'vitest';
import { SlowQueryAggregator, normalizeSlowQuerySql } from '../slow-query-aggregator.js';

describe('SlowQueryAggregator', () => {
  it('normalizes SQL shapes by replacing literals and collapsing IN lists', () => {
    const literalShape = normalizeSlowQuerySql(
      "SELECT * FROM attempts WHERE node_id = 'node-a' AND retry_count >= -1_2 AND id IN (1, 2, 3)",
    );
    const parameterShape = normalizeSlowQuerySql(
      'SELECT * FROM attempts WHERE node_id = ? AND retry_count >= ? AND id IN (?, ?, ?, ?)',
    );

    expect(literalShape).toBe('SELECT * FROM attempts WHERE node_id = ? AND retry_count >= ? AND id IN (?)');
    expect(parameterShape).toBe(literalShape);
  });

  it('keeps genuinely different SQL as separate shapes', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const aggregator = new SlowQueryAggregator({ now: () => now });

    aggregator.record({ durationMs: 10, sql: 'SELECT * FROM attempts WHERE node_id = ?', rowCount: 2 });
    aggregator.record({ durationMs: 12, sql: 'SELECT * FROM tasks WHERE node_id = ?', rowCount: 2 });

    expect(aggregator.topN()).toHaveLength(2);
  });

  it('collapses queries that differ only by literals and parameter counts into one shape', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const aggregator = new SlowQueryAggregator({ now: () => now });

    aggregator.record({
      durationMs: 10,
      sql: "SELECT * FROM attempts WHERE node_id = 'node-a' AND id IN (1, 2, 3)",
      rowCount: 3,
    });
    now += 1_000;
    aggregator.record({
      durationMs: 20,
      sql: 'SELECT * FROM attempts WHERE node_id = ? AND id IN (?, ?, ?, ?)',
      rowCount: 4,
    });

    const [entry] = aggregator.topN();
    expect(aggregator.shapeCount).toBe(1);
    expect(entry).toEqual(
      expect.objectContaining({
        shape: 'SELECT * FROM attempts WHERE node_id = ? AND id IN (?)',
        count: 2,
        maxMs: 20,
        maxRows: 4,
        firstSeenAt: '2026-01-01T00:00:00.000Z',
        lastSeenAt: '2026-01-01T00:00:01.000Z',
      }),
    );
  });

  it('computes duration percentiles and tracks max duration and max rows', () => {
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const aggregator = new SlowQueryAggregator({ now: () => now });

    for (const [durationMs, rowCount] of [
      [10, 1],
      [20, 3],
      [30, undefined],
      [40, 7],
    ] as const) {
      aggregator.record({
        durationMs,
        sql: 'SELECT * FROM attempts WHERE node_id = ?',
        ...(rowCount === undefined ? {} : { rowCount }),
      });
      now += 1_000;
    }

    const [entry] = aggregator.topN();
    expect(entry?.p50Ms).toBe(25);
    expect(entry?.p95Ms).toBeCloseTo(38.5);
    expect(entry?.maxMs).toBe(40);
    expect(entry?.maxRows).toBe(7);
  });

  it('ranks top-N entries by max duration, then count', () => {
    const now = Date.parse('2026-01-01T00:00:00.000Z');
    const aggregator = new SlowQueryAggregator({ now: () => now });

    for (const durationMs of [10, 20, 50, 45, 40]) {
      aggregator.record({ durationMs, sql: 'SELECT * FROM low_max WHERE id = ?' });
    }
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM high_max_low_count WHERE id = ?' });
    for (const durationMs of [80, 90, 100]) {
      aggregator.record({ durationMs, sql: 'SELECT * FROM high_max_high_count WHERE id = ?' });
    }

    expect(aggregator.topN(2).map((entry) => entry.shape)).toEqual([
      'SELECT * FROM high_max_high_count WHERE id = ?',
      'SELECT * FROM high_max_low_count WHERE id = ?',
    ]);
  });

  it('clears recorded stats on reset', () => {
    const aggregator = new SlowQueryAggregator();
    aggregator.record({ durationMs: 10, sql: 'SELECT * FROM attempts WHERE id = ?' });

    aggregator.reset();

    expect(aggregator.totalCount).toBe(0);
    expect(aggregator.shapeCount).toBe(0);
    expect(aggregator.topN()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { SlowQueryAggregator, normalizeSlowQuerySql } from '../slow-query-aggregator.js';

describe('SlowQueryAggregator', () => {
  it('normalizes literals, bound params, IN lists, and whitespace into one SQL shape', () => {
    const literalShape = normalizeSlowQuerySql(`
      SELECT * FROM attempts
      WHERE node_id = 'node-123'
        AND attempt_number IN (1, 2, 3)
        AND status = :status
    `);
    const paramShape = normalizeSlowQuerySql(
      'SELECT * FROM attempts WHERE node_id=? AND attempt_number IN (?, ?, ?, ?) AND status = ?',
    );

    expect(literalShape).toBe(paramShape);
    expect(literalShape).toBe(
      'SELECT * FROM attempts WHERE node_id = ? AND attempt_number IN (?) AND status = ?',
    );
    expect(normalizeSlowQuerySql('SELECT * FROM tasks WHERE node_id = ?')).not.toBe(literalShape);
  });

  it('merges same-shape records and calculates p50 and p95 with interpolation', () => {
    const aggregator = new SlowQueryAggregator();

    for (const durationMs of [10, 20, 30, 40]) {
      aggregator.record({
        durationMs,
        sql: `SELECT * FROM attempts WHERE node_id = 'node-${durationMs}'`,
      });
    }

    const [stats] = aggregator.topN();

    expect(stats).toEqual(expect.objectContaining({
      shape: 'SELECT * FROM attempts WHERE node_id = ?',
      count: 4,
      p50Ms: 25,
      p95Ms: 38.5,
      maxMs: 40,
    }));
  });

  it('tracks max duration, max rows, and first and last seen timestamps', () => {
    const instants = [
      new Date('2026-07-17T00:00:00.000Z'),
      new Date('2026-07-17T00:00:01.000Z'),
      new Date('2026-07-17T00:00:02.000Z'),
    ];
    let nextInstant = 0;
    const aggregator = new SlowQueryAggregator({
      now: () => instants[nextInstant++]!,
    });

    aggregator.record({ durationMs: 12, sql: 'SELECT * FROM attempts WHERE node_id = ?', rowCount: 2 });
    aggregator.record({ durationMs: 27, sql: 'SELECT * FROM attempts WHERE node_id = ?', rowCount: 9 });
    aggregator.record({ durationMs: 21, sql: 'SELECT * FROM attempts WHERE node_id = ?' });

    expect(aggregator.topN()[0]).toEqual(expect.objectContaining({
      count: 3,
      maxMs: 27,
      maxRows: 9,
      firstSeenAt: '2026-07-17T00:00:00.000Z',
      lastSeenAt: '2026-07-17T00:00:02.000Z',
    }));
  });

  it('ranks top-N by max duration and then count', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM first_table WHERE id = 1' });
    aggregator.record({ durationMs: 90, sql: 'SELECT * FROM second_table WHERE id = 1' });
    aggregator.record({ durationMs: 90, sql: 'SELECT * FROM second_table WHERE id = 2' });
    aggregator.record({ durationMs: 90, sql: 'SELECT * FROM second_table WHERE id = 3' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM third_table WHERE id = 1' });
    aggregator.record({ durationMs: 80, sql: 'SELECT * FROM third_table WHERE id = 2' });

    expect(aggregator.topN(2).map((stats) => stats.shape)).toEqual([
      'SELECT * FROM third_table WHERE id = ?',
      'SELECT * FROM first_table WHERE id = ?',
    ]);
    expect(aggregator.topN().map((stats) => stats.shape)).toEqual([
      'SELECT * FROM third_table WHERE id = ?',
      'SELECT * FROM first_table WHERE id = ?',
      'SELECT * FROM second_table WHERE id = ?',
    ]);
  });

  it('can reset accumulated state', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 10, sql: 'SELECT * FROM attempts WHERE id = ?' });
    aggregator.reset();

    expect(aggregator.topN()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  SlowQueryAggregator,
  normalizeSlowQuerySql,
} from '../slow-query-aggregator.js';

describe('normalizeSlowQuerySql', () => {
  it('collapses literals and IN-list parameter counts to one shape', () => {
    const literalSql = `
      SELECT * FROM attempts
      WHERE node_id = 'node-123'
        AND status = :status
        AND attempt_number IN (1, 2, 3)
    `;
    const parameterizedSql = `
      SELECT * FROM attempts
      WHERE node_id = ?
        AND status = @status
        AND attempt_number IN (?, ?, ?, ?)
    `;

    const literalShape = normalizeSlowQuerySql(literalSql);
    const parameterizedShape = normalizeSlowQuerySql(parameterizedSql);

    expect(literalShape).toBe(parameterizedShape);
    expect(literalShape).toBe(
      'SELECT * FROM attempts WHERE node_id = ? AND status = ? AND attempt_number IN (?)',
    );

    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });
    aggregator.record({ durationMs: 10, sql: literalSql });
    aggregator.record({ durationMs: 20, sql: parameterizedSql });
    expect(aggregator.shapeCount).toBe(1);
  });

  it('keeps genuinely different SQL in different shapes', () => {
    expect(normalizeSlowQuerySql('SELECT * FROM attempts WHERE id = 123')).not.toBe(
      normalizeSlowQuerySql('SELECT * FROM tasks WHERE id = 123'),
    );
    expect(normalizeSlowQuerySql('SELECT * FROM attempts_v1 WHERE id = 123')).not.toBe(
      normalizeSlowQuerySql('SELECT * FROM attempts_v2 WHERE id = 123'),
    );
  });
});

describe('SlowQueryAggregator', () => {
  it('computes p50 and p95 percentiles from recorded durations', () => {
    let now = 1_000;
    const aggregator = new SlowQueryAggregator({ now: () => now });

    for (const durationMs of [10, 20, 30, 40]) {
      aggregator.record({ durationMs, sql: 'SELECT * FROM attempts WHERE node_id = ?' });
      now += 1_000;
    }

    const [summary] = aggregator.topN();

    expect(summary).toEqual(
      expect.objectContaining({
        count: 4,
        p50Ms: 25,
        p95Ms: 38.5,
        firstSeenAt: 1_000,
        lastSeenAt: 4_000,
      }),
    );
  });

  it('tracks max duration and max returned row count per shape', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    aggregator.record({ durationMs: 12, sql: 'SELECT * FROM attempts WHERE id = ?', rowCount: 2 });
    aggregator.record({ durationMs: 99, sql: 'SELECT * FROM attempts WHERE id = 42', rowCount: 7 });
    aggregator.record({ durationMs: 50, sql: 'SELECT * FROM attempts WHERE id = 43' });

    const [summary] = aggregator.topN();

    expect(summary).toEqual(
      expect.objectContaining({
        sqlShape: 'SELECT * FROM attempts WHERE id = ?',
        count: 3,
        maxMs: 99,
        maxRows: 7,
      }),
    );
  });

  it('ranks top-N summaries by max duration, then count', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    aggregator.record({ durationMs: 80, sql: 'SELECT * FROM low WHERE id = 1' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM tied_a WHERE id = 1' });
    aggregator.record({ durationMs: 20, sql: 'SELECT * FROM tied_b WHERE id = 1' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM tied_b WHERE id = 2' });
    aggregator.record({ durationMs: 30, sql: 'SELECT * FROM tied_b WHERE id = 3' });

    expect(aggregator.topN(3).map((summary) => summary.sqlShape)).toEqual([
      'SELECT * FROM tied_b WHERE id = ?',
      'SELECT * FROM tied_a WHERE id = ?',
      'SELECT * FROM low WHERE id = ?',
    ]);
  });

  it('resets recorded samples and shapes', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    aggregator.record({ durationMs: 10, sql: 'SELECT * FROM attempts WHERE id = ?' });
    aggregator.reset();

    expect(aggregator.totalCount).toBe(0);
    expect(aggregator.shapeCount).toBe(0);
    expect(aggregator.topN()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { SlowQueryAggregator, normalizeSlowQuerySql } from '../slow-query-aggregator.js';

function record(
  aggregator: SlowQueryAggregator,
  sql: string,
  durationMs: number,
  rowCount?: number,
): void {
  aggregator.record({
    durationMs,
    sql,
    ...(rowCount === undefined ? {} : { rowCount }),
  });
}

describe('normalizeSlowQuerySql', () => {
  it('collapses literals, bound params, and IN-list param counts into one shape', () => {
    const first = normalizeSlowQuerySql(
      "SELECT * FROM attempts WHERE node_id IN ('node-a', 'node-b', 'node-c') AND attempt_id = 42 AND status = :status",
    );
    const second = normalizeSlowQuerySql(
      'SELECT * FROM attempts WHERE node_id IN (?, ?, ?, ?) AND attempt_id=99 AND status=@status',
    );

    expect(first).toBe('SELECT * FROM attempts WHERE node_id IN (?) AND attempt_id = ? AND status = ?');
    expect(second).toBe(first);
  });

  it('keeps genuinely different SQL in separate shapes', () => {
    expect(normalizeSlowQuerySql("SELECT * FROM attempts WHERE node_id = 'node-a'")).not.toBe(
      normalizeSlowQuerySql("SELECT * FROM tasks WHERE node_id = 'node-a'"),
    );
  });
});

describe('SlowQueryAggregator', () => {
  it('aggregates queries that normalize to the same SQL shape', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    record(
      aggregator,
      "SELECT * FROM attempts WHERE node_id IN ('node-a', 'node-b') AND attempt_id = 1",
      12,
    );
    record(
      aggregator,
      'SELECT * FROM attempts WHERE node_id IN (?, ?, ?, ?) AND attempt_id = ?',
      18,
    );

    expect(aggregator.topN()).toEqual([
      expect.objectContaining({
        shape: 'SELECT * FROM attempts WHERE node_id IN (?) AND attempt_id = ?',
        count: 2,
      }),
    ]);
  });

  it('computes nearest-rank p50 and p95 per shape', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });
    const sql = 'SELECT * FROM attempts WHERE node_id = ?';

    for (const durationMs of [40, 10, 30, 20, 50]) {
      record(aggregator, sql, durationMs);
    }

    expect(aggregator.topN()[0]).toEqual(
      expect.objectContaining({
        count: 5,
        p50Ms: 30,
        p95Ms: 50,
      }),
    );
  });

  it('tracks max duration, max rows, and first/last seen timestamps', () => {
    let now = 1_000;
    const aggregator = new SlowQueryAggregator({ now: () => now });
    const sql = 'SELECT * FROM attempts WHERE node_id = ?';

    record(aggregator, sql, 20, 1);
    now = 2_000;
    record(aggregator, sql, 90);
    now = 3_000;
    record(aggregator, sql, 40, 7);

    expect(aggregator.topN()[0]).toEqual(
      expect.objectContaining({
        maxMs: 90,
        maxRows: 7,
        firstSeenAt: 1_000,
        lastSeenAt: 3_000,
      }),
    );
  });

  it('ranks top-N by max duration, then count', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    record(aggregator, 'SELECT * FROM a WHERE id = ?', 50);
    record(aggregator, 'SELECT * FROM a WHERE id = ?', 30);
    record(aggregator, 'SELECT * FROM b WHERE id = ?', 200);
    record(aggregator, 'SELECT * FROM c WHERE id = ?', 50);
    record(aggregator, 'SELECT * FROM c WHERE id = ?', 40);
    record(aggregator, 'SELECT * FROM c WHERE id = ?', 20);

    expect(aggregator.topN(3).map((entry) => entry.shape)).toEqual([
      'SELECT * FROM b WHERE id = ?',
      'SELECT * FROM c WHERE id = ?',
      'SELECT * FROM a WHERE id = ?',
    ]);
    expect(aggregator.topN(2)).toHaveLength(2);
  });
});

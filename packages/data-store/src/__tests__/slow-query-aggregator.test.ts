import { describe, expect, it } from 'vitest';

import { SlowQueryAggregator, normalizeSlowQuerySql } from '../slow-query-aggregator.js';

describe('normalizeSlowQuerySql', () => {
  it('collapses literals, bound params, IN-list arity, and whitespace into a stable shape', () => {
    const literalShape = normalizeSlowQuerySql(`
      SELECT * FROM attempts
      WHERE node_id IN ('node-1', 'node-2', 'node-3')
        AND run_number = 42
        AND status = 'done'
    `);
    const parameterShape = normalizeSlowQuerySql(
      'SELECT * FROM attempts WHERE node_id IN (?, ?, ?, ?) AND run_number = ? AND status = :status',
    );

    expect(literalShape).toBe(
      'SELECT * FROM attempts WHERE node_id IN (?) AND run_number = ? AND status = ?',
    );
    expect(parameterShape).toBe(literalShape);
    expect(
      normalizeSlowQuerySql(
        "SELECT * FROM attempts WHERE id = @id AND retry_count = -12 AND payload = 'it''s fine'",
      ),
    ).toBe('SELECT * FROM attempts WHERE id = ? AND retry_count = ? AND payload = ?');
  });

  it('keeps genuinely different SQL shapes separate', () => {
    expect(
      normalizeSlowQuerySql('SELECT * FROM attempts WHERE node_id IN (1, 2, 3)'),
    ).not.toBe(
      normalizeSlowQuerySql('SELECT * FROM attempts WHERE workflow_id IN (1, 2, 3)'),
    );
  });

  it('preserves delimited identifiers instead of normalizing their contents', () => {
    expect(
      normalizeSlowQuerySql('SELECT "tenant:alpha" FROM attempts'),
    ).toBe('SELECT "tenant:alpha" FROM attempts');
    expect(
      normalizeSlowQuerySql('SELECT * FROM attempts WHERE "tenant:alpha" = 1'),
    ).not.toBe(
      normalizeSlowQuerySql('SELECT * FROM attempts WHERE "tenant:beta" = 1'),
    );
    expect(
      normalizeSlowQuerySql('SELECT `tenant:alpha` FROM attempts'),
    ).toBe('SELECT `tenant:alpha` FROM attempts');
    expect(
      normalizeSlowQuerySql('SELECT [tenant:alpha] FROM attempts'),
    ).toBe('SELECT [tenant:alpha] FROM attempts');
  });
});

describe('SlowQueryAggregator', () => {
  it('aggregates equivalent shapes and tracks percentile, max, rows, and timestamps', () => {
    const observedAtMs = [1_000, 2_000, 3_000, 4_000, 5_000];
    const aggregator = new SlowQueryAggregator({ now: () => observedAtMs.shift() ?? 0 });

    aggregator.record({
      durationMs: 10,
      sql: 'SELECT * FROM attempts WHERE node_id = 1',
      rowCount: 1,
    });
    aggregator.record({ durationMs: 30, sql: 'SELECT * FROM attempts WHERE node_id = 2' });
    aggregator.record({
      durationMs: 20,
      sql: 'SELECT * FROM attempts WHERE node_id = 3',
      rowCount: 9,
    });
    aggregator.record({
      durationMs: 50,
      sql: 'SELECT * FROM attempts WHERE node_id = ?',
      rowCount: 3,
    });
    aggregator.record({
      durationMs: 40,
      sql: 'SELECT * FROM attempts WHERE node_id = :nodeId',
      rowCount: 0,
    });

    expect(aggregator.totalCount).toBe(5);
    expect(aggregator.shapeCount).toBe(1);
    expect(aggregator.topN()).toEqual([
      {
        shape: 'SELECT * FROM attempts WHERE node_id = ?',
        count: 5,
        p50Ms: 30,
        p95Ms: 50,
        maxMs: 50,
        maxRows: 9,
        firstSeenAtMs: 1_000,
        lastSeenAtMs: 5_000,
      },
    ]);
  });

  it('ranks top-N by max duration, then count', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    aggregator.record({ durationMs: 100, sql: "SELECT * FROM attempts WHERE node_id = 'a'" });
    aggregator.record({ durationMs: 90, sql: "SELECT * FROM attempts WHERE node_id = 'b'" });
    aggregator.record({ durationMs: 200, sql: 'SELECT * FROM workflows WHERE id = ?' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM task_events WHERE task_id = ?' });
    aggregator.record({ durationMs: 95, sql: 'SELECT * FROM task_events WHERE task_id = ?' });
    aggregator.record({ durationMs: 80, sql: 'SELECT * FROM task_events WHERE task_id = ?' });

    expect(aggregator.topN(2).map((stats) => stats.shape)).toEqual([
      'SELECT * FROM workflows WHERE id = ?',
      'SELECT * FROM task_events WHERE task_id = ?',
    ]);

    aggregator.reset();
    expect(aggregator.totalCount).toBe(0);
    expect(aggregator.shapeCount).toBe(0);
    expect(aggregator.topN()).toEqual([]);
  });

  it('bounds per-shape memory instead of retaining every duration sample forever', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    for (let i = 0; i < 5_000; i += 1) {
      aggregator.record({ durationMs: i, sql: 'SELECT * FROM attempts WHERE node_id = ?' });
    }

    expect(aggregator.totalCount).toBe(5_000);
    const [stats] = aggregator.topN(1);
    expect(stats?.maxMs).toBe(4_999);
    expect(stats?.count).toBe(5_000);
    expect(stats?.p50Ms).toBeGreaterThanOrEqual(0);
    expect(stats?.p50Ms).toBeLessThanOrEqual(4_999);
  });

  it('bounds distinct tracked shapes instead of growing the shape map forever', () => {
    const aggregator = new SlowQueryAggregator({ now: () => 1_000 });

    for (let i = 0; i < 5_000; i += 1) {
      aggregator.record({ durationMs: 1, sql: `SELECT * FROM t${i} WHERE id = 'literal-${i}'` });
    }

    expect(aggregator.totalCount).toBe(5_000);
    expect(aggregator.shapeCount).toBeLessThanOrEqual(200);
  });
});

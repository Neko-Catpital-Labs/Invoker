import { describe, expect, it } from 'vitest';
import { SlowQueryAggregator, normalizeSlowQuerySql } from '../slow-query-aggregator.js';

describe('SlowQueryAggregator', () => {
  it('normalizes literal and parameter-list variants into the same SQL shape', () => {
    const literalShape = normalizeSlowQuerySql(
      "SELECT * FROM attempts WHERE node_id IN ('node-a', 'node-b', 'node-c') " +
        'AND attempt = 42 AND status = :status',
    );
    const parameterShape = normalizeSlowQuerySql(
      ' SELECT  * FROM attempts WHERE node_id IN (?, ?, ?) AND attempt = ? AND status = ? ',
    );
    const differentShape = normalizeSlowQuerySql(
      'SELECT * FROM attempts WHERE workflow_id = ? AND status = ?',
    );

    expect(literalShape).toBe('SELECT * FROM attempts WHERE node_id IN (?) AND attempt = ? AND status = ?');
    expect(parameterShape).toBe(literalShape);
    expect(differentShape).not.toBe(literalShape);

    const aggregator = new SlowQueryAggregator();
    aggregator.record({
      durationMs: 40,
      sql: "SELECT * FROM attempts WHERE node_id IN ('node-a', 'node-b')",
    });
    aggregator.record({ durationMs: 50, sql: 'SELECT * FROM attempts WHERE node_id IN (?, ?, ?)' });
    aggregator.record({ durationMs: 60, sql: 'SELECT * FROM attempts WHERE workflow_id = ?' });

    expect(aggregator.topN().map((stat) => stat.shape).sort()).toEqual([
      'SELECT * FROM attempts WHERE node_id IN (?)',
      'SELECT * FROM attempts WHERE workflow_id = ?',
    ]);
  });

  it('ignores SQL comments when normalizing query shapes', () => {
    const first = normalizeSlowQuerySql(`
      SELECT '-- not a comment' AS marker, * FROM attempts -- trace '123
      WHERE node_id = 'node-a' /* attempt ids: '1, 2, 3 */ AND attempt_id IN (1, 2)
    `);
    const second = normalizeSlowQuerySql(
      'SELECT ? AS marker, * FROM attempts WHERE node_id = ? AND attempt_id IN (?, ?, ?)',
    );

    expect(first).toBe(second);

    const aggregator = new SlowQueryAggregator();
    aggregator.record({
      durationMs: 40,
      sql: "SELECT * FROM attempts -- trace '123\nWHERE node_id = 'node-a' AND attempt_id IN (1, 2)",
    });
    aggregator.record({
      durationMs: 50,
      sql: 'SELECT * FROM attempts /* trace 456 */ WHERE node_id = ? AND attempt_id IN (?, ?, ?)',
    });

    expect(aggregator.topN()).toEqual([
      expect.objectContaining({
        shape: 'SELECT * FROM attempts WHERE node_id = ? AND attempt_id IN (?)',
        count: 2,
        maxMs: 50,
      }),
    ]);
  });

  it('computes nearest-rank p50 and p95 per SQL shape', () => {
    let now = 1_000;
    const aggregator = new SlowQueryAggregator({ now: () => now++ });

    for (let durationMs = 10; durationMs <= 200; durationMs += 10) {
      aggregator.record({ durationMs, sql: 'SELECT * FROM tasks WHERE id = ?' });
    }

    const [stats] = aggregator.topN();
    expect(stats).toEqual(
      expect.objectContaining({
        count: 20,
        p50Ms: 100,
        p95Ms: 190,
        maxMs: 200,
        firstSeenAt: 1_000,
        lastSeenAt: 1_019,
      }),
    );
  });

  it('tracks max duration and max rows independently', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 35, sql: 'SELECT * FROM events WHERE task_id = ?', rowCount: 4 });
    aggregator.record({ durationMs: 120, sql: 'SELECT * FROM events WHERE task_id = ?' });
    aggregator.record({ durationMs: 90, sql: 'SELECT * FROM events WHERE task_id = ?', rowCount: 25 });

    expect(aggregator.topN()[0]).toEqual(
      expect.objectContaining({
        count: 3,
        maxMs: 120,
        maxRows: 25,
      }),
    );
  });

  it('orders top-N results by max duration and then count', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 150, sql: 'SELECT * FROM workflow_channels WHERE id = ?' });
    aggregator.record({ durationMs: 150, sql: 'SELECT * FROM attempts WHERE id = ?' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM attempts WHERE id = ?' });
    aggregator.record({ durationMs: 80, sql: 'SELECT * FROM tasks WHERE id = ?' });
    aggregator.record({ durationMs: 70, sql: 'SELECT * FROM tasks WHERE id = ?' });
    aggregator.record({ durationMs: 60, sql: 'SELECT * FROM tasks WHERE id = ?' });

    expect(aggregator.topN(2).map((stat) => stat.shape)).toEqual([
      'SELECT * FROM attempts WHERE id = ?',
      'SELECT * FROM workflow_channels WHERE id = ?',
    ]);

    aggregator.reset();
    expect(aggregator.topN()).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import {
  normalizeSlowQuerySql,
  SlowQueryAggregator,
} from '../slow-query-aggregator.js';

describe('SlowQueryAggregator', () => {
  it('normalizes literal and parameter count differences into the same SQL shape', () => {
    const literalSql = `
      SELECT * FROM attempts
      WHERE node_id IN ('node-a', 'node-b', 'node-c')
        AND duration_ms >= 1372
        AND status = 'done'
    `;
    const parameterizedSql = `
      SELECT   *   FROM attempts
      WHERE node_id IN (:nodeA, :nodeB, :nodeC, :nodeD)
        AND duration_ms >= @minDuration
        AND status = $status
    `;
    const aggregator = new SlowQueryAggregator();

    expect(normalizeSlowQuerySql(literalSql)).toBe(normalizeSlowQuerySql(parameterizedSql));
    expect(normalizeSlowQuerySql(literalSql)).toBe(
      'SELECT * FROM attempts WHERE node_id IN (?) AND duration_ms >= ? AND status = ?',
    );

    aggregator.record({ durationMs: 30, sql: literalSql });
    aggregator.record({ durationMs: 50, sql: parameterizedSql });

    const [stats] = aggregator.topN();
    expect(aggregator.topN()).toHaveLength(1);
    expect(stats?.count).toBe(2);
    expect(stats?.shape).toBe(
      'SELECT * FROM attempts WHERE node_id IN (?) AND duration_ms >= ? AND status = ?',
    );
  });

  it('keeps genuinely different SQL shapes separate', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({
      durationMs: 40,
      sql: 'SELECT * FROM attempts WHERE node_id = ?',
    });
    aggregator.record({
      durationMs: 40,
      sql: 'SELECT * FROM attempts WHERE id = ?',
    });

    expect(aggregator.topN()).toHaveLength(2);
    expect(aggregator.topN().map((entry) => entry.shape).sort()).toEqual([
      'SELECT * FROM attempts WHERE id = ?',
      'SELECT * FROM attempts WHERE node_id = ?',
    ]);
  });

  it('calculates p50 and p95 durations for each SQL shape', () => {
    const aggregator = new SlowQueryAggregator();

    for (const durationMs of [10, 20, 30, 40, 50]) {
      aggregator.record({
        durationMs,
        sql: 'SELECT * FROM attempts WHERE node_id = ?',
      });
    }

    const [stats] = aggregator.topN();
    expect(stats?.count).toBe(5);
    expect(stats?.p50Ms).toBe(30);
    expect(stats?.p95Ms).toBeCloseTo(48);
  });

  it('tracks max duration, max rows, and first and last seen timestamps', () => {
    let now = Date.UTC(2026, 6, 18, 12, 0, 0);
    const aggregator = new SlowQueryAggregator({ now: () => now });

    aggregator.record({
      durationMs: 25,
      rowCount: 1,
      sql: 'SELECT * FROM events WHERE task_id = ?',
    });
    now += 1_000;
    aggregator.record({
      durationMs: 120,
      rowCount: 17,
      sql: 'SELECT * FROM events WHERE task_id = ?',
    });
    now += 1_000;
    aggregator.record({
      durationMs: 60,
      sql: 'SELECT * FROM events WHERE task_id = ?',
    });

    const [stats] = aggregator.topN();
    expect(stats?.maxMs).toBe(120);
    expect(stats?.maxRows).toBe(17);
    expect(stats?.firstSeenAt).toBe('2026-07-18T12:00:00.000Z');
    expect(stats?.lastSeenAt).toBe('2026-07-18T12:00:02.000Z');
  });

  it('ranks top-N by max duration, then count', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 40, sql: 'SELECT * FROM a WHERE id = ?' });
    aggregator.record({ durationMs: 40, sql: 'SELECT * FROM b WHERE id = ?' });
    aggregator.record({ durationMs: 45, sql: 'SELECT * FROM c WHERE id = ?' });
    aggregator.record({ durationMs: 40, sql: 'SELECT * FROM b WHERE id = ?' });

    expect(aggregator.topN(2).map((entry) => entry.shape)).toEqual([
      'SELECT * FROM c WHERE id = ?',
      'SELECT * FROM b WHERE id = ?',
    ]);
  });

  it('resets recorded state', () => {
    const aggregator = new SlowQueryAggregator();

    aggregator.record({ durationMs: 40, sql: 'SELECT * FROM attempts WHERE id = ?' });
    aggregator.reset();

    expect(aggregator.topN()).toEqual([]);
  });
});

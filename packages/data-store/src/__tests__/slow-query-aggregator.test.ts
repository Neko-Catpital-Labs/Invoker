import { describe, expect, it } from 'vitest';
import { SlowQueryAggregator, normalizeSqlShape } from '../slow-query-aggregator.js';

describe('normalizeSqlShape', () => {
  it('collapses SQL that differs only by literals and IN-list parameter count', () => {
    const first = normalizeSqlShape(
      "SELECT * FROM attempts WHERE node_id = 'node-a' AND attempt_id IN (1, 2, 3) AND duration_ms >= 42.5 AND status = :status",
    );
    const second = normalizeSqlShape(
      'SELECT * FROM attempts WHERE node_id = ? AND attempt_id IN (?, ?, ?, ?) AND duration_ms >= $1 AND status = @status',
    );

    expect(first).toBe(
      'SELECT * FROM attempts WHERE node_id = ? AND attempt_id IN (?) AND duration_ms >= ? AND status = ?',
    );
    expect(second).toBe(first);
  });

  it('keeps genuinely different SQL as different shapes', () => {
    expect(normalizeSqlShape('SELECT * FROM attempts WHERE node_id = ?')).not.toBe(
      normalizeSqlShape('SELECT * FROM attempts WHERE id = ?'),
    );
  });
});

describe('SlowQueryAggregator', () => {
  it('groups by normalized shape and tracks max values and timestamps', () => {
    let now = 1_700_000_000_000;
    const aggregator = new SlowQueryAggregator({ now: () => now });

    aggregator.record({
      durationMs: 25,
      sql: "SELECT * FROM attempts WHERE node_id = 'node-a' AND attempt_id IN (1, 2)",
      rowCount: 2,
    });
    now += 1_000;
    aggregator.record({
      durationMs: 50,
      sql: 'SELECT * FROM attempts WHERE node_id = ? AND attempt_id IN (?, ?, ?)',
      rowCount: 7,
    });
    now += 1_000;
    aggregator.record({
      durationMs: 75,
      sql: 'SELECT * FROM tasks WHERE id = ?',
      rowCount: 1,
    });

    const attempts = aggregator.topN().find((entry) => entry.shape.startsWith('SELECT * FROM attempts'));
    const tasks = aggregator.topN().find((entry) => entry.shape.startsWith('SELECT * FROM tasks'));

    expect(attempts).toEqual(
      expect.objectContaining({
        shape: 'SELECT * FROM attempts WHERE node_id = ? AND attempt_id IN (?)',
        count: 2,
        maxMs: 50,
        maxRows: 7,
        firstSeenAt: 1_700_000_000_000,
        lastSeenAt: 1_700_000_001_000,
      }),
    );
    expect(tasks).toEqual(
      expect.objectContaining({
        shape: 'SELECT * FROM tasks WHERE id = ?',
        count: 1,
      }),
    );
  });

  it('calculates p50 and p95 with nearest-rank percentiles', () => {
    const aggregator = new SlowQueryAggregator();
    for (const durationMs of [50, 10, 40, 20, 30]) {
      aggregator.record({ durationMs, sql: 'SELECT * FROM attempts WHERE id = ?' });
    }

    expect(aggregator.topN()[0]).toEqual(
      expect.objectContaining({
        p50Ms: 30,
        p95Ms: 50,
        maxMs: 50,
      }),
    );
  });

  it('ranks top-N by maxMs, then count', () => {
    const aggregator = new SlowQueryAggregator();
    aggregator.record({ durationMs: 90, sql: 'SELECT * FROM attempts WHERE node_id = ?' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM workflows WHERE id = ?' });
    aggregator.record({ durationMs: 100, sql: 'SELECT * FROM tasks WHERE id = ?' });
    aggregator.record({ durationMs: 80, sql: 'SELECT * FROM tasks WHERE id = ?' });

    expect(aggregator.topN(3).map((entry) => entry.shape)).toEqual([
      'SELECT * FROM tasks WHERE id = ?',
      'SELECT * FROM workflows WHERE id = ?',
      'SELECT * FROM attempts WHERE node_id = ?',
    ]);
  });

  it('resets accumulated shapes', () => {
    const aggregator = new SlowQueryAggregator();
    aggregator.record({ durationMs: 10, sql: 'SELECT * FROM attempts WHERE id = ?' });

    aggregator.reset();

    expect(aggregator.topN()).toEqual([]);
  });
});

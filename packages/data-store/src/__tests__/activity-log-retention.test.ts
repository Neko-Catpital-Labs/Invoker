import { describe, it, expect, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';

// Throttle constant baked into the adapter: it prunes at most once per N writes,
// so the on-write bound is `maxRows + ACTIVITY_LOG_PRUNE_INTERVAL`.
const PRUNE_INTERVAL = 1_000;

describe('activity_log retention', () => {
  const adapters: SQLiteAdapter[] = [];

  afterEach(() => {
    while (adapters.length) adapters.pop()?.close();
  });

  async function makeAdapter(activityLogMaxRows?: number): Promise<SQLiteAdapter> {
    const adapter = await SQLiteAdapter.create(':memory:', { activityLogMaxRows });
    adapters.push(adapter);
    return adapter;
  }

  function rowCount(adapter: SQLiteAdapter): number {
    // getActivityLogs is id-ascending; page through to count without a cap.
    let total = 0;
    let sinceId = 0;
    for (;;) {
      const batch = adapter.getActivityLogs(sinceId, 1_000);
      if (batch.length === 0) break;
      total += batch.length;
      sinceId = batch[batch.length - 1].id;
    }
    return total;
  }

  it('pruneActivityLog keeps the newest N rows and reports the deletion count', async () => {
    const adapter = await makeAdapter(100_000); // default-sized cap, prune explicitly
    for (let i = 0; i < 50; i += 1) {
      adapter.writeActivityLog('test', 'info', `msg-${i}`);
    }
    const deleted = adapter.pruneActivityLog(10);
    expect(deleted).toBe(40);
    expect(rowCount(adapter)).toBe(10);

    // The retained rows must be the newest ones (msg-40 .. msg-49).
    const remaining = adapter.getActivityLogs(0, 1_000).map((r) => r.message);
    expect(remaining).toContain('msg-49');
    expect(remaining).not.toContain('msg-39');
  });

  it('bounds the table on write without an explicit prune call', async () => {
    const cap = 500;
    const adapter = await makeAdapter(cap);
    const writes = 2 * PRUNE_INTERVAL + 500; // 2500 — crosses the throttle twice
    for (let i = 0; i < writes; i += 1) {
      adapter.writeActivityLog('flood', 'info', `entry-${i}`);
    }
    const count = rowCount(adapter);
    // Never unbounded: stays within one throttle window above the cap.
    expect(count).toBeLessThanOrEqual(cap + PRUNE_INTERVAL);
    expect(count).toBeGreaterThanOrEqual(cap);
    // Most-recent entry survives; an early one does not.
    const newest = adapter.getActivityLogs(0, writes).map((r) => r.message);
    expect(newest).toContain(`entry-${writes - 1}`);
    expect(newest).not.toContain('entry-0');
  });

  it('treats maxRows <= 0 as retention disabled (reproduces the unbounded growth)', async () => {
    const adapter = await makeAdapter(0);
    const writes = PRUNE_INTERVAL + 200; // 1200 — would trigger a prune if enabled
    for (let i = 0; i < writes; i += 1) {
      adapter.writeActivityLog('flood', 'info', `entry-${i}`);
    }
    // Disabled cap means every row is retained — this is the pre-fix behavior.
    expect(rowCount(adapter)).toBe(writes);
    // Explicit prune with a disabled cap is also a no-op.
    expect(adapter.pruneActivityLog(0)).toBe(0);
    expect(rowCount(adapter)).toBe(writes);
  });

  it('is a no-op when the table already fits under the cap', async () => {
    const adapter = await makeAdapter(100_000);
    for (let i = 0; i < 5; i += 1) {
      adapter.writeActivityLog('test', 'info', `msg-${i}`);
    }
    expect(adapter.pruneActivityLog(100)).toBe(0);
    expect(rowCount(adapter)).toBe(5);
  });
});

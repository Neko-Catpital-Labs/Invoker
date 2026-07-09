import { describe, it, expect, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';

const PRUNE_INTERVAL = 1_000; // matches ACTIVITY_LOG_PRUNE_INTERVAL in sqlite-adapter.ts

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
    const adapter = await makeAdapter(100_000);
    for (let i = 0; i < 50; i += 1) {
      adapter.writeActivityLog('test', 'info', `msg-${i}`);
    }
    expect(adapter.pruneActivityLog(10)).toBe(40);
    expect(rowCount(adapter)).toBe(10);

    const remaining = adapter.getActivityLogs(0, 1_000).map((r) => r.message);
    expect(remaining).toContain('msg-49');
    expect(remaining).not.toContain('msg-39');
  });

  it('bounds the table on write without an explicit prune call', async () => {
    const cap = 500;
    const adapter = await makeAdapter(cap);
    const writes = 2 * PRUNE_INTERVAL + 500;
    for (let i = 0; i < writes; i += 1) {
      adapter.writeActivityLog('flood', 'info', `entry-${i}`);
    }
    const count = rowCount(adapter);
    expect(count).toBeLessThanOrEqual(cap + PRUNE_INTERVAL);
    expect(count).toBeGreaterThanOrEqual(cap);

    const newest = adapter.getActivityLogs(0, writes).map((r) => r.message);
    expect(newest).toContain(`entry-${writes - 1}`);
    expect(newest).not.toContain('entry-0');
  });

  it('treats maxRows <= 0 as retention disabled (reproduces the unbounded growth)', async () => {
    const adapter = await makeAdapter(0);
    const writes = PRUNE_INTERVAL + 200;
    for (let i = 0; i < writes; i += 1) {
      adapter.writeActivityLog('flood', 'info', `entry-${i}`);
    }
    expect(rowCount(adapter)).toBe(writes);
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

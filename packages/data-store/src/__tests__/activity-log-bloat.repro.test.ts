import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

const PRUNE_INTERVAL = 1_000; // matches ACTIVITY_LOG_PRUNE_INTERVAL in sqlite-adapter.ts

// Regression repro for the ~1GB invoker.db / SIGBUS incident: proves on a real
// on-disk database that retention bounds both row count and file size.
describe('activity_log on-disk bloat is bounded by retention', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  async function floodPhase(maxRows: number, writes: number): Promise<{ rows: number; bytes: number }> {
    dir ??= mkdtempSync(join(tmpdir(), 'invoker-activity-bloat-'));
    const dbPath = join(dir, `phase-${maxRows}.db`);
    const adapter = await SQLiteAdapter.create(dbPath, {
      ownerCapability: true,
      activityLogMaxRows: maxRows,
    });
    // One transaction keeps the flood fast while still exercising the throttled prune.
    adapter.runInTransaction(() => {
      for (let i = 0; i < writes; i += 1) {
        adapter.writeActivityLog('flood', 'info', `entry-${i}-payload-padding-to-mimic-real-log-lines`);
      }
    });
    let rows = 0;
    let sinceId = 0;
    for (;;) {
      const batch = adapter.getActivityLogs(sinceId, 5_000);
      if (batch.length === 0) break;
      rows += batch.length;
      sinceId = batch[batch.length - 1].id;
    }
    adapter.close();
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try { bytes += statSync(`${dbPath}${suffix}`).size; } catch { /* sidecar may be gone */ }
    }
    return { rows, bytes };
  }

  it('grows unbounded with retention disabled but stays bounded when enabled', async () => {
    const writes = 10_000;
    const cap = 500;

    const disabled = await floodPhase(0, writes);
    const enabled = await floodPhase(cap, writes);

    expect(disabled.rows).toBe(writes);
    expect(enabled.rows).toBeLessThanOrEqual(cap + PRUNE_INTERVAL);
    expect(enabled.bytes * 2).toBeLessThan(disabled.bytes);
  });
});

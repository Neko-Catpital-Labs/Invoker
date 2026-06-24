import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';

// Must match ACTIVITY_LOG_PRUNE_INTERVAL in sqlite-adapter.ts.
const PRUNE_INTERVAL = 1_000;

/**
 * Regression repro for the ~1GB invoker.db / SIGBUS incident: activity_log grew
 * unbounded (2.58M rows / 424MB live + ~600MB free pages) and the memory-mapped
 * file faulted with SIGBUS during write-heavy operations.
 *
 * This drives a real on-disk database and proves that retention bounds BOTH the
 * row count and the file size, so the bloat cannot recur. Also exercised by
 * scripts/repro/repro-activity-log-bloat.sh.
 */
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
    // A single transaction keeps the flood fast (one fsync) while still
    // exercising the per-write throttled prune inside writeActivityLog.
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
    adapter.close(); // checkpoints WAL into the main DB file
    let bytes = 0;
    for (const suffix of ['', '-wal']) {
      try { bytes += statSync(`${dbPath}${suffix}`).size; } catch { /* sidecar may be gone */ }
    }
    return { rows, bytes };
  }

  it('grows unbounded with retention disabled but stays bounded when enabled', async () => {
    const writes = 10_000;
    const cap = 500;

    const disabled = await floodPhase(0, writes); // pre-fix behavior
    const enabled = await floodPhase(cap, writes); // with retention

    // Disabled: every row retained — this is exactly how the DB ballooned.
    expect(disabled.rows).toBe(writes);
    // Enabled: row count capped to one throttle window above maxRows.
    expect(enabled.rows).toBeLessThanOrEqual(cap + PRUNE_INTERVAL);
    // Enabled: the on-disk file does not grow with input — bloat cannot recur.
    expect(enabled.bytes * 2).toBeLessThan(disabled.bytes);
  });
});

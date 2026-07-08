/**
 * Regression: the hourly snapshot must not corrupt a live WAL-mode SQLite
 * connection.
 *
 * Field failure (Jul 8 2026, ~/.invoker/invoker.log): the running Electron
 * process (PID 45754) took an hourly snapshot at 08:04:08 UTC. Immediately
 * after, every subsequent SQLite write on the primary connection failed
 * with `SQLITE_IOERR` (errcode 522, "disk I/O error"). The recovery worker,
 * heartbeats, and terminal upserts spun in an uncaught-exception loop for
 * hours. `PRAGMA integrity_check` on the DB file was `ok`; the connection
 * state itself was wedged.
 *
 * Root cause: the pre-fix `createDbSnapshot` in `delete-all-snapshot.ts`
 * used raw `copyFileSync` against `invoker.db`, `invoker.db-wal`, AND
 * `invoker.db-shm` while a live WAL connection held all three open.
 * SQLite's WAL mode coordinates readers and writers through a
 * shared-memory wal-index in the `-shm` file; concurrent third-party access
 * to that file is unsafe per SQLite's documented file-format contract, and
 * on macOS/APFS it dropped the running connection into a persistent IOERR
 * state.
 *
 * The pre-existing coverage in `delete-all-snapshot.test.ts` wrote plain
 * text strings to the three paths, so it never exercised a real SQLite
 * connection and could not detect this class of hazard. These tests plug
 * that gap by using a real file-backed `SQLiteAdapter` in WAL mode.
 */
import { describe, expect, it, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Workflow } from '@invoker/data-store';
import { createHourlySnapshot } from '../delete-all-snapshot.js';

const roots: string[] = [];
function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'hourly-snapshot-wal-'));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const dir of roots.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

function makeWorkflow(id: string): Workflow {
  const now = new Date().toISOString();
  return { id, name: id, status: 'running', createdAt: now, updatedAt: now };
}

describe('hourly snapshot with a live WAL owner', () => {
  it('the primary connection can still write after createHourlySnapshot runs (WAL safety)', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(makeWorkflow('wf-pre-snapshot'));
      // Sanity: default WAL locking means the -shm sidecar exists; this is
      // the file that the pre-fix raw-copy path grabbed unsafely.
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

      const snapshot = createHourlySnapshot(root);
      expect(snapshot).not.toBeNull();

      // The bug in the wild manifested as SQLITE_IOERR on every write after
      // the snapshot. Post-fix, the owner connection is fully unaffected.
      expect(() => owner.saveWorkflow(makeWorkflow('wf-post-snapshot'))).not.toThrow();

      const ids = owner.listWorkflows().map((w) => w.id).sort();
      expect(ids).toEqual(['wf-post-snapshot', 'wf-pre-snapshot']);
    } finally {
      owner.close();
    }
  });

  it('does not leave WAL/SHM sidecars next to the snapshot (single-file backup)', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(makeWorkflow('wf-single-file'));

      const snapshot = createHourlySnapshot(root);
      expect(snapshot).not.toBeNull();
      // The correct snapshot format is a single-file DB. WAL/SHM sidecars on
      // the snapshot path were the smoking gun of the raw-copy approach.
      expect(existsSync(`${snapshot}-wal`)).toBe(false);
      expect(existsSync(`${snapshot}-shm`)).toBe(false);
    } finally {
      owner.close();
    }
  });
});

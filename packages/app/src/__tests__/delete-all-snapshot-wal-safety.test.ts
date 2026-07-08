/**
 * Regression: the hourly snapshot must not corrupt a live WAL-mode SQLite
 * connection.
 *
 * Field failure (Jul 8 2026, invoker.log): the running Electron process
 * (PID 45754) took an hourly snapshot at 08:04:08 UTC. Immediately after,
 * every subsequent SQLite write on the primary connection failed with
 * `SQLITE_IOERR` (errcode 522, "disk I/O error"), and the recovery worker,
 * heartbeats, and terminal upserts spun in an uncaught-exception loop for
 * hours. The database file itself was intact (`PRAGMA integrity_check = ok`).
 *
 * Root cause: the pre-fix `createDbSnapshot` in delete-all-snapshot.ts used
 * raw `copyFileSync` against `invoker.db`, `invoker.db-wal`, and
 * `invoker.db-shm` while a live WAL connection held all three open. SQLite's
 * WAL mode coordinates readers and writers through a shared-memory wal-index
 * in the `-shm` file; concurrent third-party access to that file is UB per
 * SQLite's documented file-format contract, and on macOS/APFS it dropped the
 * running connection into a persistent IOERR state.
 *
 * The pre-existing coverage in `delete-all-snapshot.test.ts` wrote plain text
 * strings to the three paths, so it never exercised a real SQLite connection
 * and could not detect this class of hazard. These tests plug that gap by
 * using a real file-backed `SQLiteAdapter` and wiring the adapter's own
 * `backupTo` (which uses the SQLite online backup API) into the snapshot
 * function — the same wiring the production callers now use.
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
      // Sanity: default WAL locking means the -shm sidecar exists; this is the
      // file that the pre-fix raw-copy path grabbed unsafely.
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

      // Adapter-backed backup: the whole point of the fix is that the snapshot
      // routes through the running adapter's SQLite online backup API instead
      // of raw-copying the live wal-index.
      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
      expect(snapshot).not.toBeNull();

      // The bug in the wild manifested as `SQLITE_IOERR` on every write after
      // the snapshot. Post-fix, the owner connection is fully unaffected.
      expect(() => owner.saveWorkflow(makeWorkflow('wf-post-snapshot'))).not.toThrow();

      const ids = owner.listWorkflows().map((w) => w.id).sort();
      expect(ids).toEqual(['wf-post-snapshot', 'wf-pre-snapshot']);
    } finally {
      owner.close();
    }
  });

  it('produces a snapshot that opens as a valid SQLite database (consistent copy)', async () => {
    const root = makeRoot();
    const dbPath = join(root, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(makeWorkflow('wf-consistent'));

      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
      expect(snapshot).not.toBeNull();

      // A safe snapshot of a live WAL DB must open in a fresh reader and
      // return the row we committed just before the snapshot. Pre-fix, the
      // snapshot came out with WAL/SHM sidecars that made the codebase's own
      // read-only opener refuse it as "WAL sidecars exist". Post-fix, the
      // snapshot is a single-file DB that opens cleanly.
      const reader = await SQLiteAdapter.create(snapshot as string, { readOnly: true });
      try {
        const ids = reader.listWorkflows().map((w) => w.id);
        expect(ids).toContain('wf-consistent');
      } finally {
        reader.close();
      }
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

      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
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

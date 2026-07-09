/**
 * Regression: the hourly snapshot must not corrupt a live WAL-mode SQLite
 * connection AND must include commits still resident in the source's WAL
 * frames.
 *
 * Bottom of the stack (`fix/hourly-snapshot-wal-safety`) closed the
 * corruption hazard by refusing to copy the live `-wal` / `-shm` sidecars.
 * That left snapshot freshness on the table — committed rows still in
 * `invoker.db-wal` (i.e. not yet checkpointed into `invoker.db`) were
 * missing from the snapshot. This slice routes the snapshot through
 * `SQLiteAdapter.backupTo`, which uses SQLite's online backup API to
 * checkpoint the WAL into the snapshot as part of the copy.
 *
 * Field failure background: Jul 8 2026 (~/.invoker/invoker.log) the
 * running Electron process (PID 45754) took an hourly snapshot at
 * 08:04:08 UTC. Every subsequent SQLite write on the primary connection
 * then failed with `SQLITE_IOERR` (errcode 522) for hours. Root cause was
 * raw `copyFileSync` against the live `-shm`. This regression covers both
 * halves of the correct fix.
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
      expect(existsSync(`${dbPath}-shm`)).toBe(true);

      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
      expect(snapshot).not.toBeNull();
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

      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
      expect(snapshot).not.toBeNull();
      expect(existsSync(`${snapshot}-wal`)).toBe(false);
      expect(existsSync(`${snapshot}-shm`)).toBe(false);
    } finally {
      owner.close();
    }
  });

  it('snapshot includes commits still resident in the live WAL (freshness)', async () => {
    // This is the core assertion for this slice. In WAL mode, recent commits
    // live in `invoker.db-wal` until a checkpoint moves them into `invoker.db`.
    // The bottom-of-stack fix (which copies only .db) misses those frames.
    // Routing through SQLiteAdapter.backupTo checkpoints them as part of the
    // online backup, so the snapshot is both WAL-safe AND WAL-complete.
    const root = makeRoot();
    const dbPath = join(root, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      // Write enough workflows to guarantee some end up in the WAL.
      // The default auto-checkpoint threshold is 1000 pages (~4MB) so these
      // rows will remain WAL-only at snapshot time.
      for (let i = 0; i < 20; i += 1) {
        owner.saveWorkflow(makeWorkflow(`wf-freshness-${i}`));
      }

      const snapshot = await createHourlySnapshot(root, (dest) => owner.backupTo(dest));
      expect(snapshot).not.toBeNull();

      // Open the snapshot in a fresh reader and confirm every commit is there.
      // If the snapshot were just a raw copy of .db, most or all of these rows
      // would be missing.
      const reader = await SQLiteAdapter.create(snapshot as string, { readOnly: true });
      try {
        const ids = new Set(reader.listWorkflows().map((w) => w.id));
        for (let i = 0; i < 20; i += 1) {
          expect(ids.has(`wf-freshness-${i}`)).toBe(true);
        }
      } finally {
        reader.close();
      }
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
});

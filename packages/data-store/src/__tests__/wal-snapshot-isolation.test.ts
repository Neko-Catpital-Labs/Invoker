import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

/**
 * Commit b2e54f4b7 removed the blanket "read-only open fails whenever WAL
 * sidecars exist" check, relying instead on SQLite's own WAL snapshot
 * isolation: an already-open reader stays pinned to the snapshot it took,
 * even while a live writer commits further changes to the same file. These
 * tests hold that guarantee to a concrete repro rather than trusting it by
 * assertion.
 */

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wal-snapshot-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeWorkflow(id: string): Workflow {
  return {
    id,
    name: id,
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('WAL snapshot isolation for an already-open reader', () => {
  it('does not observe a write made after its snapshot', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');

    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(makeWorkflow('wf-1'));

      // Same WAL PRAGMA Invoker's own connections use (configureConnection in
      // sqlite-adapter.ts); busy_timeout matters here since the reader shares
      // the file with a live writable owner.
      const reader = new DatabaseSync(dbPath, { readOnly: true });
      try {
        reader.exec('PRAGMA busy_timeout = 5000');

        // A deferred BEGIN does not itself take the WAL snapshot; the first
        // read does. Run one now so the snapshot is pinned before the
        // owner's second write commits.
        reader.exec('BEGIN');
        const beforeRows = reader.prepare('SELECT id FROM workflows ORDER BY id').all() as Array<{ id: string }>;
        expect(beforeRows.map((r) => r.id)).toEqual(['wf-1']);

        owner.saveWorkflow(makeWorkflow('wf-2'));

        // The reader's still-open transaction must stay pinned to its
        // original snapshot even though the file on disk now has two rows.
        const duringRows = reader.prepare('SELECT id FROM workflows ORDER BY id').all() as Array<{ id: string }>;
        expect(duringRows.map((r) => r.id)).toEqual(['wf-1']);

        reader.exec('COMMIT');

        // A fresh snapshot (post-commit) sees both rows.
        const afterRows = reader.prepare('SELECT id FROM workflows ORDER BY id').all() as Array<{ id: string }>;
        expect(afterRows.map((r) => r.id)).toEqual(['wf-1', 'wf-2']);
      } finally {
        reader.close();
      }
    } finally {
      owner.close();
    }
  });
});

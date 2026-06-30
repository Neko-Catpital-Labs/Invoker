import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  copyFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter, isDatabaseCorruptionError } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

/**
 * SQLiteAdapter.create() recovers a corrupt database by renaming it (and its
 * -wal/-shm sidecars) aside and starting fresh. That recovery is destructive,
 * so it must fire ONLY for genuine corruption. A transient/operational failure
 * (a concurrent process holding a lock, an IO error) must propagate untouched —
 * otherwise the live database and the -shm other connections have memory-mapped
 * would be ripped away, losing data and crashing those readers with SIGBUS.
 */

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sqlite-recovery-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('isDatabaseCorruptionError', () => {
  it('treats SQLITE_CORRUPT (11), SQLITE_NOTADB (26) and their extended variants as corruption', () => {
    expect(isDatabaseCorruptionError({ errcode: 11 })).toBe(true);
    expect(isDatabaseCorruptionError({ errcode: 26 })).toBe(true);
    // Extended result codes carry the primary code in the low byte and must
    // still classify: SQLITE_CORRUPT_VTAB=267, SQLITE_CORRUPT_SEQUENCE=523,
    // SQLITE_CORRUPT_INDEX=779 (all & 0xff === 11).
    for (const errcode of [267, 523, 779]) {
      expect(isDatabaseCorruptionError({ errcode })).toBe(true);
    }
  });

  it('does NOT treat transient/operational result codes (incl. extended) as corruption', () => {
    // Primary: SQLITE_BUSY=5, SQLITE_LOCKED=6, SQLITE_IOERR=10, SQLITE_CANTOPEN=14.
    // Extended: SQLITE_BUSY_RECOVERY=261, SQLITE_IOERR_READ=266, SQLITE_CANTOPEN_FULLPATH=782
    // (none of which mask to 11 or 26).
    for (const errcode of [5, 6, 10, 14, 261, 266, 782]) {
      expect(isDatabaseCorruptionError({ errcode })).toBe(false);
    }
  });

  it('falls back to message text when no numeric errcode is present', () => {
    expect(isDatabaseCorruptionError(new Error('database disk image is malformed'))).toBe(true);
    expect(isDatabaseCorruptionError(new Error('file is not a database'))).toBe(true);
    expect(isDatabaseCorruptionError(new Error('database is locked'))).toBe(false);
    expect(isDatabaseCorruptionError(new Error('unable to open database file'))).toBe(false);
    expect(isDatabaseCorruptionError('not even an error')).toBe(false);
  });
});

describe('SQLiteAdapter.create recovery', () => {
  it('recovers a genuinely corrupt database by backing it up and starting fresh', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const garbage = Buffer.from('xx not a sqlite header xx '.repeat(50));
    writeFileSync(dbPath, garbage);

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.listWorkflows()).toEqual([]); // fresh, usable database
    } finally {
      adapter.close();
    }

    const corruptBackups = readdirSync(dir).filter(
      (name) => name.includes('.corrupt-') && !name.endsWith('-wal') && !name.endsWith('-shm'),
    );
    expect(corruptBackups).toHaveLength(1);
    expect(readFileSync(join(dir, corruptBackups[0]))).toEqual(garbage); // original bytes preserved
  });


  it('restores the newest valid backup instead of starting fresh', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);
    const workflow: Workflow = {
      id: 'wf-preserved',
      name: 'Preserved Workflow',
      status: 'running',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const original = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      original.saveWorkflow(workflow);
      await original.backupTo(join(backupDir, 'invoker.db.hourly-auto-20260101-010000-000Z'));
    } finally {
      original.close();
    }
    writeFileSync(join(backupDir, 'invoker.db.hourly-auto-20260101-020000-000Z'), 'newer but invalid');
    copyFileSync(dbPath, join(dir, 'healthy-before-corrupt.db'));
    writeFileSync(dbPath, Buffer.from('xx not a sqlite header xx '.repeat(50)));

    const restored = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(restored.listWorkflows().map((wf) => wf.id)).toEqual(['wf-preserved']);
    } finally {
      restored.close();
    }

    const corruptBackups = readdirSync(dir).filter(
      (name) => name.includes('.corrupt-') && !name.endsWith('-wal') && !name.endsWith('-shm'),
    );
    expect(corruptBackups).toHaveLength(1);
    expect(readFileSync(join(dir, corruptBackups[0]))).not.toEqual(readFileSync(join(dir, 'healthy-before-corrupt.db')));
  });
  it('rethrows a non-corruption open failure WITHOUT the destructive recovery', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    // A directory at dbPath makes SQLite fail with SQLITE_CANTOPEN (operational,
    // not corruption). A sentinel inside proves the path is never renamed away.
    mkdirSync(dbPath);
    mkdirSync(join(dbPath, 'sentinel'));

    await expect(SQLiteAdapter.create(dbPath, { ownerCapability: true })).rejects.toThrow();

    expect(readdirSync(dir).some((name) => name.includes('.corrupt-'))).toBe(false);
    expect(existsSync(join(dbPath, 'sentinel'))).toBe(true);
  });
});

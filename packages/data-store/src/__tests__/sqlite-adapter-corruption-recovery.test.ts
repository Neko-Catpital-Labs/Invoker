import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter, isDatabaseCorruptionError } from '../sqlite-adapter.js';

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

/**
 * Seed a valid SQLite snapshot at `snapshotPath` containing the caller-supplied
 * `workflowIds`. Uses the adapter's own writer so schema + data are consistent
 * with what {@link SQLiteAdapter.create} recovery reads back. Drops the WAL/SHM
 * sidecars so the file behaves like a production `db-backups/*.hourly-auto-*`
 * snapshot produced through `backupTo` (single-file, self-contained).
 */
async function seedSnapshot(snapshotPath: string, workflowIds: string[]): Promise<void> {
  mkdirSync(join(snapshotPath, '..'), { recursive: true });
  const seed = await SQLiteAdapter.create(snapshotPath, { ownerCapability: true });
  try {
    const now = new Date().toISOString();
    for (const id of workflowIds) {
      seed.saveWorkflow({ id, name: id, createdAt: now, updatedAt: now });
    }
    seed.checkpointWal('TRUNCATE');
  } finally {
    seed.close();
  }
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${snapshotPath}${suffix}`;
    if (existsSync(sidecar)) rmSync(sidecar);
  }
}

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

/**
 * Data-preserving recovery: when the primary DB is corrupt AND a clean
 * `db-backups/*.hourly-auto-*` snapshot exists next to it, the corruption
 * branch of `SQLiteAdapter.create` MUST auto-restore from the newest clean
 * snapshot instead of silently starting empty. The prior "start fresh" branch
 * caused a real-world incident where 118 tasks / 35 workflows disappeared from
 * the UI on the next launch (`~/.invoker/invoker.db.corrupt-1783551458868`).
 */
describe('SQLiteAdapter.create auto-restore from hourly snapshot', () => {
  it('restores from the newest clean hourly snapshot when db-backups has one', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    await seedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      ['wf-older'],
    );
    await seedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z`),
      ['wf-newer-1', 'wf-newer-2'],
    );

    writeFileSync(dbPath, Buffer.from('xx not a sqlite header xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      const ids = adapter.listWorkflows().map((w) => w.id).sort();
      expect(ids).toEqual(['wf-newer-1', 'wf-newer-2']);
      expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBe(
        join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z`),
      );
      expect(adapter.corruptionRecovery?.quarantinedPath).toContain('.corrupt-');
    } finally {
      adapter.close();
    }

    const quarantined = readdirSync(dir).filter(
      (n) => n.includes('.corrupt-') && !n.endsWith('-wal') && !n.endsWith('-shm'),
    );
    expect(quarantined).toHaveLength(1);
  });

  it('skips a corrupt snapshot and falls back to the next clean one', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    await seedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      ['wf-clean-older'],
    );
    writeFileSync(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z`),
      Buffer.from('xx not a sqlite header xx '.repeat(50)),
    );

    writeFileSync(dbPath, Buffer.from('xx primary corrupt xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.listWorkflows().map((w) => w.id)).toEqual(['wf-clean-older']);
      expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBe(
        join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      );
    } finally {
      adapter.close();
    }
  });

  it('falls back to an empty DB when db-backups has no clean snapshot', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    for (const stamp of ['20260708-090000-000Z', '20260708-100000-000Z']) {
      writeFileSync(
        join(backupDir, `${basename(dbPath)}.hourly-auto-${stamp}`),
        Buffer.from('xx not a sqlite header xx '.repeat(50)),
      );
    }

    writeFileSync(dbPath, Buffer.from('xx primary corrupt xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.listWorkflows()).toEqual([]);
      expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBeNull();
      expect(adapter.corruptionRecovery?.quarantinedPath).toContain('.corrupt-');
    } finally {
      adapter.close();
    }
  });

  it('exposes null corruptionRecovery on a normal (non-recovered) open', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.corruptionRecovery).toBeNull();
    } finally {
      adapter.close();
    }
  });
});

/**
 * `quickCheck()` gives callers a cheap, deterministic way to gate destructive
 * operations (e.g. hourly snapshots) on the live DB actually being intact.
 * Without this the snapshot ring silently propagates a corrupt image for hours
 * once corruption starts — every clean backup gets overwritten before the next
 * boot triggers auto-restore, defeating the recovery invariant above.
 */
describe('SQLiteAdapter.quickCheck', () => {
  it('returns true on a freshly created database', async () => {
    const dir = makeDir();
    const adapter = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
    try {
      expect(adapter.quickCheck()).toBe(true);
    } finally {
      adapter.close();
    }
  });

  it('returns true after the auto-restore recovery finishes', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);
    await seedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z`),
      ['wf-restored'],
    );
    writeFileSync(dbPath, Buffer.from('xx not a sqlite header xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.quickCheck()).toBe(true);
      expect(adapter.listWorkflows().map((w) => w.id)).toEqual(['wf-restored']);
    } finally {
      adapter.close();
    }
  });
});

import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  existsSync,
  createReadStream,
  createWriteStream,
  unlinkSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import {
  SQLiteAdapter,
  isDatabaseCorruptionError,
  isCorruptionRecoveryEligible,
  findLatestCleanHourlySnapshot,
} from '../sqlite-adapter.js';

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

/**
 * Seed a valid SQLite snapshot the same way {@link seedSnapshot} does, then
 * gzip it in place to `<path>.gz` and remove the raw intermediate — matching
 * exactly what `createDbSnapshot` in `packages/app/src/delete-all-snapshot.ts`
 * produces in production. Returns the final `.gz` path.
 */
async function seedGzippedSnapshot(snapshotPath: string, workflowIds: string[]): Promise<string> {
  await seedSnapshot(snapshotPath, workflowIds);
  const gzPath = `${snapshotPath}.gz`;
  await pipeline(createReadStream(snapshotPath), createGzip(), createWriteStream(gzPath));
  unlinkSync(snapshotPath);
  return gzPath;
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

describe('isCorruptionRecoveryEligible', () => {
  const corruptionErr = { errcode: 11 }; // SQLITE_CORRUPT
  const operationalErr = { errcode: 14 }; // SQLITE_CANTOPEN, not corruption

  it('is eligible when the target is a file, writable, existing, and the error is corruption', () => {
    expect(isCorruptionRecoveryEligible(corruptionErr, {
      isFile: true,
      readOnly: false,
      dbPathExists: true,
    })).toBe(true);
  });

  it('is NOT eligible for a non-file (e.g. in-memory/ephemeral) database', () => {
    expect(isCorruptionRecoveryEligible(corruptionErr, {
      isFile: false,
      readOnly: false,
      dbPathExists: true,
    })).toBe(false);
  });

  it('is NOT eligible when opened read-only', () => {
    expect(isCorruptionRecoveryEligible(corruptionErr, {
      isFile: true,
      readOnly: true,
      dbPathExists: true,
    })).toBe(false);
  });

  it('is NOT eligible when the db file does not exist yet', () => {
    expect(isCorruptionRecoveryEligible(corruptionErr, {
      isFile: true,
      readOnly: false,
      dbPathExists: false,
    })).toBe(false);
  });

  it('is NOT eligible when the error is not classified as corruption', () => {
    expect(isCorruptionRecoveryEligible(operationalErr, {
      isFile: true,
      readOnly: false,
      dbPathExists: true,
    })).toBe(false);
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

  it('restores from a gzip-compressed hourly snapshot (production write format)', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    const olderGz = await seedGzippedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      ['wf-older'],
    );
    const newerGz = await seedGzippedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z`),
      ['wf-newer-1', 'wf-newer-2'],
    );
    expect(olderGz).toMatch(/\.gz$/);
    expect(newerGz).toMatch(/\.gz$/);

    writeFileSync(dbPath, Buffer.from('xx not a sqlite header xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      const ids = adapter.listWorkflows().map((w) => w.id).sort();
      expect(ids).toEqual(['wf-newer-1', 'wf-newer-2']);
      expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBe(newerGz);
    } finally {
      adapter.close();
    }
  });

  it('skips a corrupt .gz snapshot (undecodable gzip stream) and falls back to the next clean one', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    const cleanGz = await seedGzippedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      ['wf-clean-older'],
    );
    // Not valid gzip data at all -- decompression itself must fail, and
    // fileQuickCheckOk must treat that the same as any other bad candidate.
    writeFileSync(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-100000-000Z.gz`),
      Buffer.from('not a gzip stream '.repeat(50)),
    );

    writeFileSync(dbPath, Buffer.from('xx primary corrupt xx '.repeat(50)));

    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      expect(adapter.listWorkflows().map((w) => w.id)).toEqual(['wf-clean-older']);
      expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBe(cleanGz);
    } finally {
      adapter.close();
    }
  });

  it('never leaves dbPath partially written when the restore write itself fails after a clean snapshot passed its own check', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);

    await seedGzippedSnapshot(
      join(backupDir, `${basename(dbPath)}.hourly-auto-20260708-090000-000Z`),
      ['wf-clean'],
    );
    writeFileSync(dbPath, Buffer.from('xx primary corrupt xx '.repeat(50)));

    // Pin the staging filename so we can pre-occupy it with a directory,
    // forcing the restore write (gunzip -> stagingPath) to fail with EISDIR
    // instead of succeeding -- the same failure shape as a disk-full or
    // permission error mid-write.
    const fixedNow = 1_700_000_000_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(fixedNow);
    const stagingPath = `${dbPath}.restore-staging-${fixedNow}`;
    mkdirSync(stagingPath);

    try {
      const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
      try {
        // Falls back to a fresh empty database -- NOT the snapshot's data,
        // and NOT the pre-corrupt original -- proving dbPath never ended up
        // holding a partial write from the failed staging attempt.
        expect(adapter.listWorkflows()).toEqual([]);
        expect(adapter.corruptionRecovery?.restoredFromSnapshot).toBeNull();
      } finally {
        adapter.close();
      }
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('findLatestCleanHourlySnapshot picks the newest clean snapshot from a fixture directory, skipping corrupt ones', async () => {
    const dir = makeDir();
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);
    const dbBasename = 'invoker.db';

    await seedSnapshot(join(backupDir, `${dbBasename}.hourly-auto-20260708-090000-000Z`), ['wf-clean-older']);
    writeFileSync(
      join(backupDir, `${dbBasename}.hourly-auto-20260708-100000-000Z`),
      Buffer.from('xx not a sqlite header xx '.repeat(50)),
    );

    const result = await findLatestCleanHourlySnapshot(backupDir, dbBasename);
    expect(result).toBe(join(backupDir, `${dbBasename}.hourly-auto-20260708-090000-000Z`));
  });

  it('findLatestCleanHourlySnapshot returns null when no snapshot in the fixture directory is clean', async () => {
    const dir = makeDir();
    const backupDir = join(dir, 'db-backups');
    mkdirSync(backupDir);
    const dbBasename = 'invoker.db';
    writeFileSync(
      join(backupDir, `${dbBasename}.hourly-auto-20260708-090000-000Z`),
      Buffer.from('xx not a sqlite header xx '.repeat(50)),
    );

    const result = await findLatestCleanHourlySnapshot(backupDir, dbBasename);
    expect(result).toBeNull();
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

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
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter, isDatabaseCorruptionError, isTransientIoError } from '../sqlite-adapter.js';

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

describe('isTransientIoError', () => {
  it('treats SQLITE_IOERR (10) and its extended variants as transient I/O', () => {
    // SQLITE_IOERR=10, SQLITE_IOERR_READ=266, SQLITE_IOERR_SHORT_READ=522,
    // SQLITE_IOERR_FSYNC=1034 — all carry 10 in the low byte.
    for (const errcode of [10, 266, 522, 1034]) {
      expect(isTransientIoError({ errcode })).toBe(true);
    }
  });

  it('does NOT treat corruption or lock contention as transient I/O', () => {
    // SQLITE_CORRUPT=11, SQLITE_NOTADB=26, SQLITE_BUSY=5, SQLITE_LOCKED=6,
    // SQLITE_CANTOPEN=14, SQLITE_FULL=13 (disk full is not IOERR).
    for (const errcode of [11, 26, 5, 6, 14, 13, 523]) {
      expect(isTransientIoError({ errcode })).toBe(false);
    }
  });

  it('falls back to message text when no numeric errcode is present', () => {
    expect(isTransientIoError(new Error('disk I/O error'))).toBe(true);
    expect(isTransientIoError(new Error('database disk image is malformed'))).toBe(false);
    expect(isTransientIoError(new Error('database is locked'))).toBe(false);
    expect(isTransientIoError('not even an error')).toBe(false);
  });
});

describe('SQLiteAdapter read reconnect on transient I/O error', () => {
  const workflow = {
    id: 'wf-ioerr',
    name: 'IO Error Workflow',
    status: 'running' as const,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function shortReadError(): Error {
    const err = new Error('disk I/O error') as Error & { errcode: number };
    err.errcode = 522; // SQLITE_IOERR_SHORT_READ
    return err;
  }

  it('reopens the connection and retries a read after a transient SQLITE_IOERR', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      adapter.saveWorkflow(workflow); // committed to WAL before the fault

      // Simulate a stale file descriptor: the next prepared read throws
      // SHORT_READ. reopenConnection() swaps in a fresh handle, so this stub is
      // hit once; the retry (and every later read) uses the fresh connection.
      let faultReads = 0;
      (adapter as unknown as { db: unknown }).db = {
        prepare() {
          faultReads += 1;
          throw shortReadError();
        },
      };

      const workflows = adapter.listWorkflows();
      const afterReconnect = adapter.listWorkflows();

      expect(faultReads).toBe(1); // faulted once, reconnected, never faulted again
      expect(workflows.map((w) => w.id)).toContain('wf-ioerr');
      expect(afterReconnect.map((w) => w.id)).toContain('wf-ioerr');
    } finally {
      adapter.close();
    }
  });

  it('does NOT retry (propagates) when a write transaction is in flight', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    const realDb = (adapter as unknown as { db: unknown }).db;
    try {
      // Force writeTransactionDepth > 0 so a mid-transaction reopen (which would
      // abandon the transaction) is refused and the error propagates.
      (adapter as unknown as { writeTransactionDepth: number }).writeTransactionDepth = 1;
      (adapter as unknown as { db: unknown }).db = {
        prepare() {
          throw shortReadError();
        },
      };
      expect(() => adapter.listWorkflows()).toThrow(/disk I\/O error/);
    } finally {
      (adapter as unknown as { writeTransactionDepth: number }).writeTransactionDepth = 0;
      (adapter as unknown as { db: unknown }).db = realDb;
      adapter.close();
    }
  });

  it('does NOT reopen an ephemeral (:memory:) database — the error propagates', async () => {
    const adapter = await SQLiteAdapter.createEphemeral();
    const realDb = (adapter as unknown as { db: unknown }).db;
    try {
      (adapter as unknown as { db: unknown }).db = {
        prepare() {
          throw shortReadError();
        },
      };
      // Reopening :memory: would silently discard all data, so recovery is
      // refused for non-file-backed connections and the error surfaces.
      expect(() => adapter.listWorkflows()).toThrow(/disk I\/O error/);
    } finally {
      (adapter as unknown as { db: unknown }).db = realDb;
      adapter.close();
    }
  });
});

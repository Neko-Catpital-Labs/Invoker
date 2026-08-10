import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteAdapter, hasLiveWritableOwner, applyExclusiveLockingBeforeWal } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

/**
 * WAL `locking_mode = EXCLUSIVE` keeps the wal-index in heap memory, so SQLite
 * never creates the `-shm` file. That sidecar is the one whose in-place
 * truncation under a live memory-map can kill a process with SIGBUS.
 */

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'excl-lock-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const wf: Workflow = {
  id: 'wf-1',
  name: 'wf',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

describe('SQLiteAdapter exclusiveLocking', () => {
  it('keeps the wal-index in heap so no -shm file is created', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true, exclusiveLocking: true });
    try {
      adapter.saveWorkflow(wf);
      expect(adapter.listWorkflows().map((w) => w.id)).toEqual(['wf-1']); // fully functional
      expect(existsSync(`${dbPath}-shm`)).toBe(false); // the immunity property
      expect(existsSync(`${dbPath}-wal`)).toBe(true); // still WAL, just heap wal-index
    } finally {
      adapter.close();
    }
  });

  it('applyExclusiveLockingBeforeWal sets EXCLUSIVE locking_mode when true, leaves default when false', () => {
    const dir = makeDir();

    const exclusiveDb = new DatabaseSync(join(dir, 'exclusive.db'));
    try {
      applyExclusiveLockingBeforeWal(exclusiveDb, true);
      expect((exclusiveDb.prepare('PRAGMA locking_mode').get() as { locking_mode?: string }).locking_mode).toBe('exclusive');
    } finally {
      exclusiveDb.close();
    }

    const normalDb = new DatabaseSync(join(dir, 'normal.db'));
    try {
      applyExclusiveLockingBeforeWal(normalDb, false);
      expect((normalDb.prepare('PRAGMA locking_mode').get() as { locking_mode?: string }).locking_mode).toBe('normal');
    } finally {
      normalDb.close();
    }
  });

  it('control: default WAL locking creates the mappable -shm sidecar', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      adapter.saveWorkflow(wf);
      adapter.listWorkflows();
      expect(existsSync(`${dbPath}-shm`)).toBe(true); // the file that, truncated under mmap, causes SIGBUS
    } finally {
      adapter.close();
    }
  });

  it('allows read-only file-backed opens while a normal WAL owner is live', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(wf);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(existsSync(`${dbPath}.owner`)).toBe(true);
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      try {
        expect(reader.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
      } finally {
        reader.close();
      }
    } finally {
      owner.close();
    }
    expect(existsSync(`${dbPath}.owner`)).toBe(false);
  });

  it('rejects read-only viewers while an exclusive-locking owner is live', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true, exclusiveLocking: true });
    try {
      owner.saveWorkflow(wf);
      expect(existsSync(`${dbPath}-wal`)).toBe(true);
      expect(existsSync(`${dbPath}-shm`)).toBe(false);
      // The read-only rejection below is driven by hasLiveWritableOwner; pin its
      // verdict here so the two cannot silently diverge in this sidecar shape.
      expect(hasLiveWritableOwner(dbPath)).toBe(true);
      await expect(
        SQLiteAdapter.create(dbPath, { readOnly: true }),
      ).rejects.toThrow(/exclusive locking.*read-only viewers/i);
    } finally {
      owner.close();
    }
  });

  it('allows a read-only open when a stale owner marker survives in the exclusive-locking sidecar shape', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true, exclusiveLocking: true });
    owner.saveWorkflow(wf);
    expect(existsSync(`${dbPath}-wal`)).toBe(true);
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    // Snapshot the live -wal bytes before the owner cleanly shuts down (which
    // would checkpoint it away), then restore them after close to recreate the
    // filesystem state a crashed owner would leave behind: -wal present with no
    // -shm, and a stale marker naming a PID that is no longer alive.
    const walSnapshot = readFileSync(`${dbPath}-wal`);
    owner.close();
    writeFileSync(`${dbPath}-wal`, walSnapshot);
    // PID 2^22 is above every configured pid_max, so it can never be alive.
    writeFileSync(`${dbPath}.owner`, '4194304', 'utf-8');

    // Both the exported guard and the read-only open it gates must agree that
    // no live writable owner remains in this sidecar shape.
    expect(hasLiveWritableOwner(dbPath)).toBe(false);
    const survivor = await SQLiteAdapter.create(dbPath, { readOnly: true });
    try {
      expect(survivor.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
    } finally {
      survivor.close();
    }
  });

  it('read-only opens are still allowed after a clean close', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();

    expect(existsSync(`${dbPath}-shm`)).toBe(false);
    expect(existsSync(`${dbPath}-wal`)).toBe(false);

    const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
    try {
      expect(reader.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
    } finally {
      reader.close();
    }
  });

  it('allows a second read-only open after an earlier reader left sidecars behind', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();

    // A read-only connection creates -wal/-shm and cannot checkpoint them away
    // on close, so the sidecars outlive it with no owner behind them.
    const first = await SQLiteAdapter.create(dbPath, { readOnly: true });
    first.close();
    expect(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)).toBe(true);

    const second = await SQLiteAdapter.create(dbPath, { readOnly: true });
    try {
      expect(second.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
    } finally {
      second.close();
    }
  });

  it('ignores an owner marker left by a dead process', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();

    const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
    reader.close();
    // PID 2^22 is above every configured pid_max, so it can never be alive.
    writeFileSync(`${dbPath}.owner`, '4194304', 'utf-8');

    const survivor = await SQLiteAdapter.create(dbPath, { readOnly: true });
    try {
      expect(survivor.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
    } finally {
      survivor.close();
    }
  });

  it('rejects exclusiveLocking on a read-only open (only the sole owner may use it)', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    // Seed the file so a read-only open is otherwise valid.
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.close();
    await expect(
      SQLiteAdapter.create(dbPath, { readOnly: true, exclusiveLocking: true }),
    ).rejects.toThrow(/sole opener/);
  });

  it('rejects exclusiveLocking on a non-owner writable open', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    await expect(
      SQLiteAdapter.create(dbPath, { exclusiveLocking: true }),
    ).rejects.toThrow(/sole opener/);
  });
});

describe('hasLiveWritableOwner', () => {
  it('is true while a live owner holds the db with WAL sidecars', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(wf);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(existsSync(`${dbPath}.owner`)).toBe(true);
      expect(hasLiveWritableOwner(dbPath)).toBe(true);
    } finally {
      owner.close();
    }
  });

  it('is false after a clean close leaves no sidecars', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();
    expect(hasLiveWritableOwner(dbPath)).toBe(false);
  });

  it('is false when sidecars exist but the owner marker names a dead process', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();

    // A read-only reader leaves -wal/-shm behind with no live owner.
    const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
    reader.close();
    expect(existsSync(`${dbPath}-wal`) || existsSync(`${dbPath}-shm`)).toBe(true);
    // PID 2^22 is above every configured pid_max, so it can never be alive.
    writeFileSync(`${dbPath}.owner`, '4194304', 'utf-8');

    expect(hasLiveWritableOwner(dbPath)).toBe(false);
  });
});

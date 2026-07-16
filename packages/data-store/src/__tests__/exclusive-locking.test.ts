import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
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

  it('rejects read-only file-backed opens while live WAL sidecars exist', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(wf);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
      expect(existsSync(`${dbPath}.owner`)).toBe(true);
      await expect(
        SQLiteAdapter.create(dbPath, { readOnly: true }),
      ).rejects.toThrow(/writable owner PID \d+ holds live WAL sidecars/i);
    } finally {
      owner.close();
    }
    expect(existsSync(`${dbPath}.owner`)).toBe(false);
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

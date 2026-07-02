import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
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

  it('read-only file-backed opens use the WAL shared-memory sidecar', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    try {
      owner.saveWorkflow(wf);
      // A read-only connection can still participate in active WAL shared state.
      // So readOnly on the real file is not a no-shm viewer boundary.
      const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
      try {
        expect(reader.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
        expect(existsSync(`${dbPath}-shm`)).toBe(true);
      } finally {
        reader.close();
      }
    } finally {
      owner.close();
    }
  });

  it('read-only WAL opens recreate a missing shared-memory sidecar when SQLite can create it', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    owner.saveWorkflow(wf);
    owner.close();

    rmSync(`${dbPath}-shm`, { force: true });
    expect(existsSync(`${dbPath}-shm`)).toBe(false);

    const reader = await SQLiteAdapter.create(dbPath, { readOnly: true });
    try {
      expect(reader.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
      expect(existsSync(`${dbPath}-shm`)).toBe(true);
    } finally {
      reader.close();
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

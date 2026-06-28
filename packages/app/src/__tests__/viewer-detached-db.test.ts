import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '@invoker/data-store';
import type { Workflow } from '@invoker/data-store';

/**
 * The GUI viewer is wired (main.ts initServices, detachedViewer) to back its
 * in-process services with `SQLiteAdapter.create(':memory:')` instead of opening
 * `invoker.db`. This proves the safety property that decision relies on: an
 * in-memory adapter is fully functional yet opens no database file, so it maps
 * no `-shm` wal-index — the sidecar whose truncation under a live mmap causes
 * the SIGBUS this whole stack eliminates.
 */

const dirs: string[] = [];
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'viewer-detached-'));
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

describe('detached viewer in-memory persistence', () => {
  it('is usable but opens no database file (no -shm to truncate)', async () => {
    const dir = makeDir();
    const probeDbPath = join(dir, 'invoker.db');
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const adapter = await SQLiteAdapter.create(':memory:');
      try {
        // Fully functional: schema is present and writes/reads work in memory.
        expect(adapter.listWorkflows()).toEqual([]);
        adapter.saveWorkflow(wf);
        expect(adapter.listWorkflows().map((w) => w.id)).toEqual(['wf-1']);
        // Telemetry writes the viewer's logger attempts must not throw in memory.
        expect(() => adapter.writeActivityLog('viewer', 'info', 'hello')).not.toThrow();

        // The immunity property: no file, no -wal, no -shm anywhere.
        expect(existsSync(probeDbPath)).toBe(false);
        expect(existsSync(`${probeDbPath}-shm`)).toBe(false);
        expect(existsSync(`${probeDbPath}-wal`)).toBe(false);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        adapter.close();
      }
    } finally {
      process.chdir(previousCwd);
    }
  });

  it('does not require owner capability (it never touches the shared file)', async () => {
    // File-backed writable opens demand ownerCapability; in-memory must not.
    const adapter = await SQLiteAdapter.create(':memory:');
    try {
      expect(adapter).toBeDefined();
    } finally {
      adapter.close();
    }
  });
});

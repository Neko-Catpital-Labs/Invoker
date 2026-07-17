import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openMainProcessDatabase, openDetachedViewerDatabase } from '../viewer-db-boundary.js';
import type { Workflow } from '@invoker/data-store';

/**
 * Detached GUI viewers must never open the shared `invoker.db` file. They use
 * process-local placeholder persistence while renderer reads delegate to the
 * owner over IPC.
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

describe('detached viewer persistence boundary', () => {
  it('uses empty in-memory persistence for read-only startup when the db file is absent', async () => {
    const dir = makeDir();
    const missingDbPath = join(dir, 'invoker.db');
    const adapter = await openMainProcessDatabase({
      dbPath: missingDbPath,
      detachedViewer: false,
      readOnly: true,
      exclusiveLocking: false,
    });

    try {
      expect(adapter.listWorkflows()).toEqual([]);
      expect(existsSync(missingDbPath)).toBe(false);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      adapter.close();
    }
  });

  it('ignores the real db path and opens no database file (no -shm to truncate)', async () => {
    const dir = makeDir();
    const probeDbPath = join(dir, 'invoker.db');
    const previousCwd = process.cwd();
    process.chdir(dir);
    try {
      const adapter = await openMainProcessDatabase({
        dbPath: probeDbPath,
        detachedViewer: true,
        readOnly: true,
        exclusiveLocking: true,
      });
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
    const adapter = await openDetachedViewerDatabase();
    try {
      expect(adapter).toBeDefined();
    } finally {
      adapter.close();
    }
  });
});

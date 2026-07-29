import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '@invoker/data-store';
import { openMainProcessDatabase, openDetachedViewerDatabase } from '../viewer-db-boundary.js';
import type { Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

/**
 * Detached GUI viewers may open the shared `invoker.db` file read-only. React
 * still crosses only the IPC bridge; this boundary belongs to Electron main.
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

function task(id: string): TaskState {
  return {
    id,
    description: id,
    status: 'running',
    dependencies: [],
    createdAt: new Date('2026-07-29T00:00:00.000Z'),
    config: { workflowId: wf.id, command: 'echo hello' },
    execution: { phase: 'executing' },
    taskStateVersion: 2,
  } as TaskState;
}

async function seedDb(dbPath: string): Promise<void> {
  const owner = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  try {
    owner.saveWorkflow(wf);
    owner.saveTask(wf.id, task('wf-1/hello-world'));
  } finally {
    owner.close();
  }
}

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

  it('opens the real database read-only when it exists', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    await seedDb(dbPath);

    const adapter = await openMainProcessDatabase({
      dbPath,
      detachedViewer: true,
      readOnly: true,
      exclusiveLocking: true,
    });
    try {
      expect(adapter.listWorkflows().map((item) => item.id)).toEqual(['wf-1']);
      expect(adapter.loadTasks(wf.id).map((item) => item.id)).toEqual(['wf-1/hello-world']);
      expect(adapter.loadTask('wf-1/hello-world')?.status).toBe('running');
    } finally {
      adapter.close();
    }
  });

  it('rejects detached viewer writes when the real database exists', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    await seedDb(dbPath);

    const adapter = await openMainProcessDatabase({
      dbPath,
      detachedViewer: true,
      readOnly: true,
      exclusiveLocking: false,
    });
    try {
      expect(() => adapter.updateTask('wf-1/hello-world', { status: 'completed' })).toThrow(/read-only/i);
      expect(() => adapter.saveWorkflow({ ...wf, id: 'wf-2' })).toThrow(/read-only/i);
    } finally {
      adapter.close();
    }
  });

  it('keeps an explicit ephemeral placeholder helper for absent databases', async () => {
    const adapter = await openDetachedViewerDatabase();
    try {
      expect(adapter).toBeDefined();
    } finally {
      adapter.close();
    }
  });

  it('does not silently fall back to empty persistence when read-only open fails', async () => {
    const dir = makeDir();
    const dbPath = join(dir, 'invoker.db');
    writeFileSync(dbPath, 'not sqlite', 'utf-8');

    await expect(openMainProcessDatabase({
      dbPath,
      detachedViewer: true,
      readOnly: true,
      exclusiveLocking: false,
    })).rejects.toThrow();
  });
});

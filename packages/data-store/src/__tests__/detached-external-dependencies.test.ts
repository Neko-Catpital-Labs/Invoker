import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { TaskState } from '@invoker/workflow-core';

describe('detachedExternalDependencies persistence', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'detached-ext-deps-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const testWorkflow: Workflow = {
    id: 'wf-test',
    name: 'Detached Provenance Workflow',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date(),
      config: {},
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  it('round-trips detached provenance via saveTask while leaving active deps empty', async () => {
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    adapter.saveTask(testWorkflow.id, makeTask('t1', {
      config: {
        // Active dependency removed by detach; only provenance remains.
        detachedExternalDependencies: [
          {
            workflowId: 'wf-upstream',
            taskId: '__merge__wf-upstream',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-06-02T08:57:38.000Z',
          },
        ],
      },
    }));

    // Close and re-open to force a real load from disk.
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].config.externalDependencies).toBeUndefined();
    expect(tasks[0].config.detachedExternalDependencies).toEqual([
      {
        workflowId: 'wf-upstream',
        taskId: '__merge__wf-upstream',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
        detachedAt: '2026-06-02T08:57:38.000Z',
      },
    ]);

    adapter.close();
  });

  it('persists detached provenance written via updateTask', async () => {
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    adapter.saveTask(testWorkflow.id, makeTask('t2', {
      config: {
        externalDependencies: [
          { workflowId: 'wf-up', taskId: '__merge__wf-up', requiredStatus: 'completed', gatePolicy: 'completed' },
        ],
      },
    }));

    // Simulate detachWorkflow's write: drop active edge, append provenance.
    adapter.updateTask('t2', {
      config: {
        externalDependencies: undefined,
        detachedExternalDependencies: [
          {
            workflowId: 'wf-up',
            taskId: '__merge__wf-up',
            requiredStatus: 'completed',
            gatePolicy: 'completed',
            detachedAt: '2026-06-02T08:57:38.000Z',
          },
        ],
      },
    });

    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks[0].config.externalDependencies).toBeUndefined();
    expect(tasks[0].config.detachedExternalDependencies).toHaveLength(1);
    expect(tasks[0].config.detachedExternalDependencies![0]).toMatchObject({
      workflowId: 'wf-up',
      taskId: '__merge__wf-up',
      detachedAt: '2026-06-02T08:57:38.000Z',
    });

    adapter.close();
  });

  it('stores NULL when no provenance is present', async () => {
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('t3'));

    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks[0].config.detachedExternalDependencies).toBeUndefined();

    const raw = adapter['queryAll'](
      'SELECT detached_external_dependencies FROM tasks WHERE id = ?',
      ['t3'],
    ) as Array<{ detached_external_dependencies: string | null }>;
    expect(raw[0].detached_external_dependencies).toBeNull();

    adapter.close();
  });
});

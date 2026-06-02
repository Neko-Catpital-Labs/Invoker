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
    tmpDir = mkdtempSync(join(tmpdir(), 'detached-ext-dep-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const testWorkflow: Workflow = {
    id: 'wf-test',
    name: 'Detached Provenance Test Workflow',
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

  it('round-trips detachedExternalDependencies through save/load', async () => {
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    const task = makeTask('t1', {
      config: {
        detachedExternalDependencies: [
          {
            workflowId: 'wf-upstream',
            taskId: '__merge__',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-06-02T00:00:00.000Z',
          },
        ],
      },
    });
    adapter.saveTask(testWorkflow.id, task);

    // Close and re-open to prove the column persists to disk.
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].config.detachedExternalDependencies).toEqual([
      {
        workflowId: 'wf-upstream',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
        detachedAt: '2026-06-02T00:00:00.000Z',
      },
    ]);
    // Active dependencies remain untouched/absent.
    expect(tasks[0].config.externalDependencies).toBeUndefined();

    adapter.close();
  });

  it('persists provenance via updateTask config changes', async () => {
    const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    adapter.saveTask(
      testWorkflow.id,
      makeTask('t2', {
        config: {
          externalDependencies: [
            { workflowId: 'wf-upstream', requiredStatus: 'completed', gatePolicy: 'review_ready' },
          ],
        },
      }),
    );

    // Simulate detach: drop the active dep, append provenance.
    adapter.updateTask('t2', {
      config: {
        externalDependencies: undefined,
        detachedExternalDependencies: [
          {
            workflowId: 'wf-upstream',
            requiredStatus: 'completed',
            gatePolicy: 'review_ready',
            detachedAt: '2026-06-02T12:00:00.000Z',
          },
        ],
      },
    });

    const [reloaded] = adapter.loadTasks(testWorkflow.id);
    expect(reloaded.config.externalDependencies).toBeUndefined();
    expect(reloaded.config.detachedExternalDependencies).toEqual([
      {
        workflowId: 'wf-upstream',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
        detachedAt: '2026-06-02T12:00:00.000Z',
      },
    ]);

    adapter.close();
  });
});

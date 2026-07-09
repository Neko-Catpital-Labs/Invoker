import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { TaskState } from '@invoker/workflow-core';

describe('migrateGatePolicyApprovedToCompleted', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'migrate-gate-policy-test-'));
    dbPath = join(tmpDir, 'test.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  const testWorkflow: Workflow = {
    id: 'wf-test',
    name: 'Migration Test Workflow',
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

  function seedLegacyTaskExternalDependencies(
    adapter: SQLiteAdapter,
    taskId: string,
    deps: Array<Record<string, unknown>>,
  ): void {
    adapter['execRun']('UPDATE tasks SET external_dependencies = ? WHERE id = ?', [
      JSON.stringify(deps),
      taskId,
    ]);
  }

  it('migrates gatePolicy from approved to completed', async () => {
    // Create adapter and seed with older data
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    const legacyDeps = [
      {
        workflowId: 'wf-x',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'approved' as any, // Legacy value
      },
    ];
    const taskWithLegacyGatePolicy = makeTask('t1');

    adapter.saveTask(testWorkflow.id, taskWithLegacyGatePolicy);
    seedLegacyTaskExternalDependencies(adapter, 't1', legacyDeps);

    // Close and re-open to trigger migration
    adapter.close();

    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    // Verify migration occurred
    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].config.externalDependencies).toBeUndefined();
    expect(adapter.loadWorkflow(testWorkflow.id)!.externalDependencies).toEqual([
      {
        workflowId: 'wf-x',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'completed',
      },
    ]);

    // Verify no 'approved' values remain in JSON
    const rawTask = adapter['queryAll'](
      'SELECT external_dependencies FROM tasks WHERE id = ?',
      ['t1'],
    ) as Array<{ external_dependencies: string | null }>;
    expect(rawTask[0].external_dependencies).toBeNull();
    const rawWorkflow = adapter['queryAll'](
      'SELECT external_dependencies FROM workflows WHERE id = ?',
      [testWorkflow.id],
    ) as Array<{ external_dependencies: string }>;
    expect(rawWorkflow[0].external_dependencies).not.toContain('"gatePolicy":"approved"');
    expect(rawWorkflow[0].external_dependencies).toContain('"gatePolicy":"completed"');

    adapter.close();
  });

  it('is idempotent - running migration twice leaves data unchanged', async () => {
    // Create adapter and seed with older data
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    const legacyDeps = [
      {
        workflowId: 'wf-y',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'approved' as any,
      },
    ];
    const taskWithLegacyGatePolicy = makeTask('t2');

    adapter.saveTask(testWorkflow.id, taskWithLegacyGatePolicy);
    seedLegacyTaskExternalDependencies(adapter, 't2', legacyDeps);

    // First migration
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const afterFirstMigration = adapter.loadTasks(testWorkflow.id);
    expect(afterFirstMigration[0].config.externalDependencies).toBeUndefined();
    expect(adapter.loadWorkflow(testWorkflow.id)!.externalDependencies![0].gatePolicy).toBe('completed');

    // Second migration (should be no-op)
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    const afterSecondMigration = adapter.loadTasks(testWorkflow.id);
    expect(afterSecondMigration[0].config.externalDependencies).toBeUndefined();
    expect(adapter.loadWorkflow(testWorkflow.id)!.externalDependencies![0].gatePolicy).toBe('completed');

    // Verify JSON is identical
    const raw = adapter['queryAll'](
      'SELECT external_dependencies FROM workflows WHERE id = ?',
      [testWorkflow.id],
    ) as Array<{ external_dependencies: string }>;
    expect(raw[0].external_dependencies).toContain('"gatePolicy":"completed"');

    adapter.close();
  });

  it('leaves review_ready gatePolicy untouched', async () => {
    // Create adapter and seed with review_ready policy
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    const reviewReadyDeps = [
      {
        workflowId: 'wf-z',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready',
      },
    ];
    const taskWithReviewReadyPolicy = makeTask('t3');

    adapter.saveTask(testWorkflow.id, taskWithReviewReadyPolicy);
    seedLegacyTaskExternalDependencies(adapter, 't3', reviewReadyDeps);

    // Trigger migration
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    // Verify review_ready is unchanged
    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks[0].config.externalDependencies).toBeUndefined();
    expect(adapter.loadWorkflow(testWorkflow.id)!.externalDependencies![0].gatePolicy).toBe('review_ready');

    adapter.close();
  });

  it('handles tasks with multiple external dependencies', async () => {
    // Create adapter and seed with mixed older and current data
    let adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
    adapter.saveWorkflow(testWorkflow);

    const mixedDeps = [
      {
        workflowId: 'wf-a',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'approved' as any, // Legacy
      },
      {
        workflowId: 'wf-b',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'review_ready', // Current
      },
      {
        workflowId: 'wf-c',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'approved' as any, // Legacy
      },
    ];
    const taskWithMixedDeps = makeTask('t4');

    adapter.saveTask(testWorkflow.id, taskWithMixedDeps);
    seedLegacyTaskExternalDependencies(adapter, 't4', mixedDeps);

    // Trigger migration
    adapter.close();
    adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

    // Verify all approved values migrated, review_ready untouched
    const tasks = adapter.loadTasks(testWorkflow.id);
    expect(tasks[0].config.externalDependencies).toBeUndefined();
    const workflowDeps = adapter.loadWorkflow(testWorkflow.id)!.externalDependencies!;
    expect(workflowDeps).toHaveLength(3);
    expect(workflowDeps[0].gatePolicy).toBe('completed');
    expect(workflowDeps[1].gatePolicy).toBe('review_ready');
    expect(workflowDeps[2].gatePolicy).toBe('completed');

    adapter.close();
  });
});

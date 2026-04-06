import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAttempt, createTaskState } from '@invoker/workflow-core';

describe('Attempt persistence', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    // Create a workflow and task so FK constraints pass
    adapter.saveWorkflow({
      id: 'wf-1', name: 'Test', status: 'running',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    });
    const task = createTaskState('taskA', 'Task A', [], { workflowId: 'wf-1' });
    adapter.saveTask('wf-1', task);
  });

  afterEach(() => {
    adapter.close();
  });

  it('round-trip: saveAttempt + loadAttempt', () => {
    const attempt = createAttempt('taskA', {
      status: 'running',
      snapshotCommit: 'abc123',
      baseBranch: 'main',
      upstreamAttemptIds: ['dep-a1'],
      commandOverride: 'pnpm test --watch',
      startedAt: new Date('2024-01-01T00:00:00Z'),
      branch: 'invoker/taskA-a1',
    });

    adapter.saveAttempt(attempt);
    const loaded = adapter.loadAttempt(attempt.id);

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe(attempt.id);
    expect(loaded!.nodeId).toBe('taskA');
    expect(loaded!.status).toBe('running');
    expect(loaded!.snapshotCommit).toBe('abc123');
    expect(loaded!.baseBranch).toBe('main');
    expect(loaded!.upstreamAttemptIds).toEqual(['dep-a1']);
    expect(loaded!.commandOverride).toBe('pnpm test --watch');
    expect(loaded!.startedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(loaded!.branch).toBe('invoker/taskA-a1');
    expect(loaded!.createdAt).toBeInstanceOf(Date);
  });

  it('loadAttempts returns ordered by created_at', () => {
    const a1 = createAttempt('taskA', { status: 'completed' });
    // Ensure distinct created_at by bumping time
    const a2 = createAttempt('taskA', { status: 'superseded', createdAt: new Date(Date.now() + 1000) } as any);
    const a3 = createAttempt('taskA', { status: 'pending', createdAt: new Date(Date.now() + 2000) } as any);

    adapter.saveAttempt(a3);
    adapter.saveAttempt(a1);
    adapter.saveAttempt(a2);

    const attempts = adapter.loadAttempts('taskA');
    expect(attempts).toHaveLength(3);
    // Should be ordered by created_at ASC
    expect(attempts[0].id).toBe(a1.id);
    expect(attempts[1].id).toBe(a2.id);
    expect(attempts[2].id).toBe(a3.id);
  });

  it('loadAttempt returns undefined for missing ID', () => {
    expect(adapter.loadAttempt('nonexistent')).toBeUndefined();
  });

  it('updateAttempt updates specific fields', () => {
    const attempt = createAttempt('taskA', { status: 'running' });
    adapter.saveAttempt(attempt);

    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      exitCode: 0,
      completedAt: new Date('2024-01-01T01:00:00Z'),
      branch: 'invoker/taskA-a1',
      commit: 'def456',
    });

    const loaded = adapter.loadAttempt(attempt.id)!;
    expect(loaded.status).toBe('completed');
    expect(loaded.exitCode).toBe(0);
    expect(loaded.completedAt).toEqual(new Date('2024-01-01T01:00:00Z'));
    expect(loaded.branch).toBe('invoker/taskA-a1');
    expect(loaded.commit).toBe('def456');
  });

  it('merge conflict JSON round-trip', () => {
    const attempt = createAttempt('taskA', {
      mergeConflict: {
        failedBranch: 'feat/broken',
        conflictFiles: ['src/main.ts', 'package.json'],
      },
    });
    adapter.saveAttempt(attempt);

    const loaded = adapter.loadAttempt(attempt.id)!;
    expect(loaded.mergeConflict).toEqual({
      failedBranch: 'feat/broken',
      conflictFiles: ['src/main.ts', 'package.json'],
    });
  });

  it('selected_attempt_id column exists on tasks table', () => {
    // The migration should have added the column
    const attempt = createAttempt('taskA', { status: 'completed' });
    adapter.saveAttempt(attempt);

    // Access the raw db to verify column exists (sql.js API)
    const db = (adapter as any).db;
    db.run('UPDATE tasks SET selected_attempt_id = ? WHERE id = ?', [attempt.id, 'taskA']);
    const stmt = db.prepare('SELECT selected_attempt_id FROM tasks WHERE id = ?');
    stmt.bind(['taskA']);
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    expect(row.selected_attempt_id).toBe(attempt.id);
  });
});

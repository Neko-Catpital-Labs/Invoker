import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAttempt, createTaskState } from '@invoker/core';

describe('Attempt persistence', () => {
  let adapter: SQLiteAdapter;

  beforeEach(() => {
    adapter = new SQLiteAdapter(':memory:');
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
    const attempt = createAttempt('taskA', 1, {
      status: 'running',
      snapshotCommit: 'abc123',
      baseBranch: 'main',
      upstreamAttemptIds: ['dep-a1'],
      commandOverride: 'pnpm test --watch',
      startedAt: new Date('2024-01-01T00:00:00Z'),
      branch: 'invoker/taskA-a1',
    });

    adapter.saveAttempt(attempt);
    const loaded = adapter.loadAttempt('taskA-a1');

    expect(loaded).toBeDefined();
    expect(loaded!.id).toBe('taskA-a1');
    expect(loaded!.nodeId).toBe('taskA');
    expect(loaded!.attemptNumber).toBe(1);
    expect(loaded!.status).toBe('running');
    expect(loaded!.snapshotCommit).toBe('abc123');
    expect(loaded!.baseBranch).toBe('main');
    expect(loaded!.upstreamAttemptIds).toEqual(['dep-a1']);
    expect(loaded!.commandOverride).toBe('pnpm test --watch');
    expect(loaded!.startedAt).toEqual(new Date('2024-01-01T00:00:00Z'));
    expect(loaded!.branch).toBe('invoker/taskA-a1');
    expect(loaded!.createdAt).toBeInstanceOf(Date);
  });

  it('loadAttempts returns ordered by attempt_number', () => {
    adapter.saveAttempt(createAttempt('taskA', 3, { status: 'pending' }));
    adapter.saveAttempt(createAttempt('taskA', 1, { status: 'completed' }));
    adapter.saveAttempt(createAttempt('taskA', 2, { status: 'superseded' }));

    const attempts = adapter.loadAttempts('taskA');
    expect(attempts).toHaveLength(3);
    expect(attempts.map(a => a.attemptNumber)).toEqual([1, 2, 3]);
  });

  it('loadAttempt returns undefined for missing ID', () => {
    expect(adapter.loadAttempt('nonexistent')).toBeUndefined();
  });

  it('updateAttempt updates specific fields', () => {
    adapter.saveAttempt(createAttempt('taskA', 1, { status: 'running' }));

    adapter.updateAttempt('taskA-a1', {
      status: 'completed',
      exitCode: 0,
      completedAt: new Date('2024-01-01T01:00:00Z'),
      branch: 'invoker/taskA-a1',
      commit: 'def456',
    });

    const loaded = adapter.loadAttempt('taskA-a1')!;
    expect(loaded.status).toBe('completed');
    expect(loaded.exitCode).toBe(0);
    expect(loaded.completedAt).toEqual(new Date('2024-01-01T01:00:00Z'));
    expect(loaded.branch).toBe('invoker/taskA-a1');
    expect(loaded.commit).toBe('def456');
  });

  it('getNextAttemptNumber starts at 1 and increments', () => {
    expect(adapter.getNextAttemptNumber('taskA')).toBe(1);

    adapter.saveAttempt(createAttempt('taskA', 1));
    expect(adapter.getNextAttemptNumber('taskA')).toBe(2);

    adapter.saveAttempt(createAttempt('taskA', 2));
    expect(adapter.getNextAttemptNumber('taskA')).toBe(3);
  });

  it('merge conflict JSON round-trip', () => {
    adapter.saveAttempt(createAttempt('taskA', 1, {
      mergeConflict: {
        failedBranch: 'feat/broken',
        conflictFiles: ['src/main.ts', 'package.json'],
      },
    }));

    const loaded = adapter.loadAttempt('taskA-a1')!;
    expect(loaded.mergeConflict).toEqual({
      failedBranch: 'feat/broken',
      conflictFiles: ['src/main.ts', 'package.json'],
    });
  });

  it('selected_attempt_id column exists on tasks table', () => {
    // The migration should have added the column
    // Save a task and verify we can set selected_attempt_id via raw SQL
    adapter.saveAttempt(createAttempt('taskA', 1, { status: 'completed' }));

    // Access the raw db to verify column exists
    const db = (adapter as any).db;
    db.prepare('UPDATE tasks SET selected_attempt_id = ? WHERE id = ?').run('taskA-a1', 'taskA');
    const row = db.prepare('SELECT selected_attempt_id FROM tasks WHERE id = ?').get('taskA') as any;
    expect(row.selected_attempt_id).toBe('taskA-a1');
  });
});

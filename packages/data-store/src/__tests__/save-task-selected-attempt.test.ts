import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { assertSaveTaskPersistsSelectedAttemptId } from '../sqlite-task-attempt-repository.js';

describe('saveTask selected_attempt_id persistence', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    adapter.close();
  });

  it('round-trips execution.selectedAttemptId written only via saveTask', () => {
    const task = createTaskState('taskA', 'Task A', [], { workflowId: 'wf-1' });
    adapter.saveTask('wf-1', task);

    const attempt = createAttempt('taskA', { status: 'running' });
    adapter.saveAttempt(attempt);

    adapter.saveTask('wf-1', {
      ...task,
      status: 'running',
      execution: { ...task.execution, selectedAttemptId: attempt.id },
    });

    const [loaded] = adapter.loadTasks('wf-1');
    expect(loaded.execution.selectedAttemptId).toBe(attempt.id);
  });

  it('assertSaveTaskPersistsSelectedAttemptId passes when the bound value matches exec.selectedAttemptId', () => {
    expect(() =>
      assertSaveTaskPersistsSelectedAttemptId(
        ['id', 'selected_attempt_id', 'status'],
        ['taskA', 'attempt-1', 'running'],
        { selectedAttemptId: 'attempt-1' },
      ),
    ).not.toThrow();

    expect(() =>
      assertSaveTaskPersistsSelectedAttemptId(
        ['id', 'selected_attempt_id', 'status'],
        ['taskA', null, 'running'],
        { selectedAttemptId: undefined },
      ),
    ).not.toThrow();
  });

  it('assertSaveTaskPersistsSelectedAttemptId throws when selected_attempt_id is missing or mismatched', () => {
    expect(() =>
      assertSaveTaskPersistsSelectedAttemptId(
        ['id', 'status'],
        ['taskA', 'running'],
        { selectedAttemptId: 'attempt-1' },
      ),
    ).toThrow();

    expect(() =>
      assertSaveTaskPersistsSelectedAttemptId(
        ['id', 'selected_attempt_id', 'status'],
        ['taskA', 'attempt-mismatched', 'running'],
        { selectedAttemptId: 'attempt-1' },
      ),
    ).toThrow();
  });
});

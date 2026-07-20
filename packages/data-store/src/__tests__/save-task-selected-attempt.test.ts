import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import { createAttempt, createTaskState } from '@invoker/workflow-core';

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
});

/**
 * Tests for applyDelta — the core state update function.
 */

import { describe, it, expect } from 'vitest';
import { applyDelta } from '../lib/delta.js';
import type { TaskState, TaskDelta } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    description: 'test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
    ...overrides,
  };
}

describe('applyDelta', () => {
  it('created: adds task to map', () => {
    const tasks = new Map<string, TaskState>();
    const task = makeTask({ id: 'task-1', description: 'First task' });
    const delta: TaskDelta = { type: 'created', task };

    const result = applyDelta(tasks, delta);

    expect(result.size).toBe(1);
    expect(result.get('task-1')).toEqual(task);
    // Original map unchanged (immutability)
    expect(tasks.size).toBe(0);
  });

  it('updated: merges changes into existing task', () => {
    const task = makeTask({ id: 'task-1', status: 'pending' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'task-1',
      changes: { status: 'running', execution: { startedAt: new Date('2025-01-02') } },
    };

    const result = applyDelta(tasks, delta);

    expect(result.get('task-1')!.status).toBe('running');
    expect(result.get('task-1')!.execution.startedAt).toEqual(new Date('2025-01-02'));
    // Other fields preserved
    expect(result.get('task-1')!.description).toBe('test task');
    // Original unchanged
    expect(tasks.get('task-1')!.status).toBe('pending');
  });

  it('updated: merges nested config changes', () => {
    const task = makeTask({ id: 'task-1', config: { command: 'echo old' } });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'task-1',
      changes: { config: { command: 'echo new' } },
    };

    const result = applyDelta(tasks, delta);

    expect(result.get('task-1')!.config.command).toBe('echo new');
    // Original config unchanged
    expect(tasks.get('task-1')!.config.command).toBe('echo old');
  });

  it('updated: ignores unknown taskId', () => {
    const task = makeTask({ id: 'task-1' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'nonexistent',
      changes: { status: 'running' },
    };

    const result = applyDelta(tasks, delta);

    expect(result.size).toBe(1);
    expect(result.get('task-1')!.status).toBe('pending');
    expect(result.has('nonexistent')).toBe(false);
  });

  it('removed: deletes task from map', () => {
    const task = makeTask({ id: 'task-1' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const delta: TaskDelta = { type: 'removed', taskId: 'task-1' };

    const result = applyDelta(tasks, delta);

    expect(result.size).toBe(0);
    expect(result.has('task-1')).toBe(false);
    // Original unchanged
    expect(tasks.size).toBe(1);
  });
});

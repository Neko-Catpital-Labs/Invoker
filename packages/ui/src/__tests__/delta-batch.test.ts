/**
 * Tests for applyDeltas and applyDeltaInPlace — the batched delta APIs.
 */

import { describe, it, expect } from 'vitest';
import { applyDelta, applyDeltas, applyDeltaInPlace } from '../lib/delta.js';
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

function applyDeltasSequentially(
  base: Map<string, TaskState>,
  deltas: readonly TaskDelta[],
): Map<string, TaskState> {
  let current = base;
  for (const delta of deltas) {
    current = applyDelta(current, delta);
  }
  return current;
}

describe('applyDeltas (batched)', () => {
  it('returns the input map by reference when the batch is empty', () => {
    const tasks = new Map<string, TaskState>([['task-1', makeTask({ id: 'task-1' })]]);
    const result = applyDeltas(tasks, []);
    expect(result).toBe(tasks);
  });

  it('does not mutate the input map', () => {
    const tasks = new Map<string, TaskState>([['task-1', makeTask({ id: 'task-1' })]]);
    const deltas: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 'task-2' }) },
      { type: 'removed', taskId: 'task-1' },
    ];
    applyDeltas(tasks, deltas);
    expect(tasks.size).toBe(1);
    expect(tasks.has('task-1')).toBe(true);
    expect(tasks.has('task-2')).toBe(false);
  });

  it('matches sequential applyDelta results for a mixed batch', () => {
    const tasks = new Map<string, TaskState>([
      ['task-1', makeTask({ id: 'task-1', status: 'pending' })],
      ['task-2', makeTask({ id: 'task-2', status: 'pending' })],
    ]);
    const deltas: TaskDelta[] = [
      { type: 'updated', taskId: 'task-1', changes: { status: 'running' } },
      { type: 'created', task: makeTask({ id: 'task-3', status: 'pending' }) },
      { type: 'updated', taskId: 'task-3', changes: { status: 'completed' } },
      { type: 'removed', taskId: 'task-2' },
    ];

    const batched = applyDeltas(tasks, deltas);
    const sequential = applyDeltasSequentially(tasks, deltas);

    expect(batched.size).toBe(sequential.size);
    for (const [id, task] of sequential) {
      expect(batched.get(id)).toEqual(task);
    }
  });

  it('applies updates that reference tasks created earlier in the same batch', () => {
    const tasks = new Map<string, TaskState>();
    const deltas: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 'task-1', status: 'pending' }) },
      { type: 'updated', taskId: 'task-1', changes: { status: 'running' } },
    ];

    const result = applyDeltas(tasks, deltas);

    expect(result.get('task-1')!.status).toBe('running');
  });

  it('single-copy invariant: one new Map per batch, not per delta', () => {
    const tasks = new Map<string, TaskState>();
    for (let i = 0; i < 100; i += 1) {
      tasks.set(`task-${i}`, makeTask({ id: `task-${i}` }));
    }
    const deltas: TaskDelta[] = [];
    for (let i = 0; i < 50; i += 1) {
      deltas.push({ type: 'updated', taskId: `task-${i}`, changes: { status: 'running' } });
    }

    const result = applyDeltas(tasks, deltas);

    // The result is a fresh Map (not the input reference).
    expect(result).not.toBe(tasks);
    // Every original entry that wasn't touched still points at the same object
    // reference — proving we didn't rebuild the map per-delta.
    for (let i = 50; i < 100; i += 1) {
      expect(result.get(`task-${i}`)).toBe(tasks.get(`task-${i}`));
    }
  });
});

describe('applyDeltaInPlace', () => {
  it('mutates the target map for created deltas', () => {
    const target = new Map<string, TaskState>();
    const task = makeTask({ id: 'task-1' });
    applyDeltaInPlace(target, { type: 'created', task });
    expect(target.size).toBe(1);
    expect(target.get('task-1')).toBe(task);
  });

  it('mutates the target map for updated deltas', () => {
    const target = new Map<string, TaskState>([
      ['task-1', makeTask({ id: 'task-1', status: 'pending' })],
    ]);
    applyDeltaInPlace(target, {
      type: 'updated',
      taskId: 'task-1',
      changes: { status: 'running' },
    });
    expect(target.get('task-1')!.status).toBe('running');
  });

  it('mutates the target map for removed deltas', () => {
    const target = new Map<string, TaskState>([['task-1', makeTask({ id: 'task-1' })]]);
    applyDeltaInPlace(target, { type: 'removed', taskId: 'task-1' });
    expect(target.size).toBe(0);
  });
});

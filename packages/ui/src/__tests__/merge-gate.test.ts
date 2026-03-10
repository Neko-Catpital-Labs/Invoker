import { describe, it, expect } from 'vitest';
import { computeMergeGateStatus, findLeafTasks, MERGE_GATE_ID } from '../lib/merge-gate.js';
import type { TaskState } from '../types.js';

function makeTask(id: string, status: TaskState['status'], deps: string[] = []): TaskState {
  return { id, description: `Task ${id}`, status, dependencies: deps, createdAt: new Date() };
}

describe('computeMergeGateStatus', () => {
  it('returns completed when all tasks completed', () => {
    const tasks = [makeTask('a', 'completed'), makeTask('b', 'completed')];
    expect(computeMergeGateStatus(tasks)).toBe('completed');
  });

  it('returns failed when any task failed', () => {
    const tasks = [makeTask('a', 'completed'), makeTask('b', 'failed')];
    expect(computeMergeGateStatus(tasks)).toBe('failed');
  });

  it('returns failed when any task blocked', () => {
    const tasks = [makeTask('a', 'completed'), makeTask('b', 'blocked')];
    expect(computeMergeGateStatus(tasks)).toBe('failed');
  });

  it('returns pending when tasks still running', () => {
    const tasks = [makeTask('a', 'completed'), makeTask('b', 'running')];
    expect(computeMergeGateStatus(tasks)).toBe('pending');
  });

  it('returns pending when tasks still pending', () => {
    const tasks = [makeTask('a', 'pending'), makeTask('b', 'pending')];
    expect(computeMergeGateStatus(tasks)).toBe('pending');
  });

  it('returns pending for empty array', () => {
    expect(computeMergeGateStatus([])).toBe('pending');
  });

  it('failed takes priority over in-progress tasks', () => {
    const tasks = [makeTask('a', 'running'), makeTask('b', 'failed'), makeTask('c', 'pending')];
    expect(computeMergeGateStatus(tasks)).toBe('failed');
  });
});

describe('findLeafTasks', () => {
  it('returns all tasks when none have dependents', () => {
    const tasks = [makeTask('a', 'pending'), makeTask('b', 'pending')];
    const leaves = findLeafTasks(tasks);
    expect(leaves.map(t => t.id).sort()).toEqual(['a', 'b']);
  });

  it('excludes tasks that are dependencies of other tasks', () => {
    const tasks = [
      makeTask('a', 'completed'),
      makeTask('b', 'completed', ['a']),
      makeTask('c', 'completed', ['b']),
    ];
    const leaves = findLeafTasks(tasks);
    expect(leaves.map(t => t.id)).toEqual(['c']);
  });

  it('returns multiple leaves in a fan-out DAG', () => {
    // a → b, a → c (both b and c are leaves)
    const tasks = [
      makeTask('a', 'completed'),
      makeTask('b', 'completed', ['a']),
      makeTask('c', 'completed', ['a']),
    ];
    const leaves = findLeafTasks(tasks);
    expect(leaves.map(t => t.id).sort()).toEqual(['b', 'c']);
  });

  it('returns empty array for empty input', () => {
    expect(findLeafTasks([])).toEqual([]);
  });

  it('handles diamond DAG correctly', () => {
    // a → b, a → c, b → d, c → d (only d is leaf)
    const tasks = [
      makeTask('a', 'completed'),
      makeTask('b', 'completed', ['a']),
      makeTask('c', 'completed', ['a']),
      makeTask('d', 'completed', ['b', 'c']),
    ];
    const leaves = findLeafTasks(tasks);
    expect(leaves.map(t => t.id)).toEqual(['d']);
  });
});

describe('MERGE_GATE_ID', () => {
  it('is a stable constant', () => {
    expect(MERGE_GATE_ID).toBe('__merge_gate__');
  });
});

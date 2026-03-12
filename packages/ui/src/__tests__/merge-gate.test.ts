import { describe, it, expect } from 'vitest';
import { computeMergeGateStatus, findLeafTasks, mergeGateId, isMergeGateId, groupTasksByWorkflow, MERGE_GATE_ID } from '../lib/merge-gate.js';
import type { TaskState } from '../types.js';

function makeTask(id: string, status: TaskState['status'], deps: string[] = [], workflowId?: string): TaskState {
  return { id, description: `Task ${id}`, status, dependencies: deps, config: { workflowId }, execution: {}, createdAt: new Date() };
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

describe('mergeGateId', () => {
  it('produces unique IDs per workflow', () => {
    const gateA = mergeGateId('wf-a');
    const gateB = mergeGateId('wf-b');
    expect(gateA).not.toBe(gateB);
    expect(gateA).toContain('wf-a');
    expect(gateB).toContain('wf-b');
  });

  it('starts with __merge_gate__ prefix', () => {
    expect(mergeGateId('wf-1')).toMatch(/^__merge_gate__/);
  });
});

describe('isMergeGateId', () => {
  it('returns true for merge gate IDs', () => {
    expect(isMergeGateId(mergeGateId('wf-a'))).toBe(true);
    expect(isMergeGateId(MERGE_GATE_ID)).toBe(true);
  });

  it('returns false for regular task IDs', () => {
    expect(isMergeGateId('t1')).toBe(false);
    expect(isMergeGateId('setup-env')).toBe(false);
  });
});

describe('groupTasksByWorkflow', () => {
  it('groups tasks by workflowId', () => {
    const tasks = [
      makeTask('a1', 'pending', [], 'wf-a'),
      makeTask('a2', 'running', [], 'wf-a'),
      makeTask('b1', 'completed', [], 'wf-b'),
    ];
    const groups = groupTasksByWorkflow(tasks);
    expect(groups.size).toBe(2);
    expect(groups.get('wf-a')!.map(t => t.id)).toEqual(['a1', 'a2']);
    expect(groups.get('wf-b')!.map(t => t.id)).toEqual(['b1']);
  });

  it('puts tasks without workflowId into "unknown"', () => {
    const tasks = [makeTask('t1', 'pending')];
    const groups = groupTasksByWorkflow(tasks);
    expect(groups.has('unknown')).toBe(true);
    expect(groups.get('unknown')!).toHaveLength(1);
  });

  it('returns empty map for empty input', () => {
    expect(groupTasksByWorkflow([]).size).toBe(0);
  });

  it('computeMergeGateStatus scoped to workflow tasks', () => {
    const tasksA = [makeTask('a1', 'completed', [], 'wf-a'), makeTask('a2', 'completed', [], 'wf-a')];
    const tasksB = [makeTask('b1', 'failed', [], 'wf-b')];

    expect(computeMergeGateStatus(tasksA)).toBe('completed');
    expect(computeMergeGateStatus(tasksB)).toBe('failed');
  });
});

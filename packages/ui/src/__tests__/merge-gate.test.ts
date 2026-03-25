import { describe, it, expect } from 'vitest';
import {
  computeMergeGateStatus,
  findLeafTasks,
  mergeGateId,
  isMergeGateId,
  groupTasksByWorkflow,
  MERGE_GATE_ID,
  mergeGateKindFromDescription,
  mergeGatePanelHeading,
  mergeGatePlanTitle,
  resolveMergeGateKind,
} from '../lib/merge-gate.js';
import type { TaskState, WorkflowMeta } from '../types.js';

function makeTask(id: string, status: TaskState['status'], deps: string[] = [], workflowId?: string): TaskState {
  return { id, description: `Task ${id}`, status, dependencies: deps, config: { workflowId }, execution: {}, createdAt: new Date() };
}

function makeMergeTask(description: string, workflowId = 'wf-1', execution: Partial<TaskState['execution']> = {}): TaskState {
  return {
    id: `__merge__${workflowId}`,
    description,
    status: 'pending',
    dependencies: [],
    config: { workflowId, isMergeNode: true },
    execution: { ...execution },
    createdAt: new Date(),
  };
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

describe('mergeGateKindFromDescription / mergeGatePlanTitle / resolveMergeGateKind', () => {
  it('parses GitHub PR gate prefix', () => {
    const desc = 'GitHub PR gate for My feature';
    expect(mergeGateKindFromDescription(desc)).toBe('github_pr');
    expect(mergeGatePlanTitle(desc)).toBe('My feature');
  });

  it('parses pull request gate prefix', () => {
    const desc = 'Pull request gate for Plan B';
    expect(mergeGateKindFromDescription(desc)).toBe('pull_request');
    expect(mergeGatePlanTitle(desc)).toBe('Plan B');
  });

  it('resolveMergeGateKind prefers description over workflow meta', () => {
    const task = makeMergeTask('Merge gate for Legacy', 'wf-x');
    const wf: WorkflowMeta = {
      id: 'wf-x',
      name: 'Legacy',
      status: 'running',
      mergeMode: 'github',
      onFinish: 'pull_request',
    };
    expect(resolveMergeGateKind(task, wf)).toBe('merge');
  });

  it('resolveMergeGateKind falls back to workflow when description has no prefix', () => {
    const task = makeMergeTask('Custom merge gate text', 'wf-y');
    expect(
      resolveMergeGateKind(task, {
        id: 'wf-y',
        name: 'Y',
        status: 'running',
        mergeMode: 'github',
      }),
    ).toBe('github_pr');
  });
});

describe('mergeGatePanelHeading', () => {
  const mergeTask = (desc: string, extras?: Partial<TaskState['execution']>): TaskState => makeMergeTask(desc, 'wf-1', extras);

  it('rewrites Pull request gate to GitHub PR gate when mergeMode is github', () => {
    const task = mergeTask('Pull request gate for Plan A');
    expect(mergeGatePanelHeading(task, 'github')).toBe('GitHub PR gate for Plan A');
  });

  it('is case-insensitive on pull request prefix', () => {
    const task = mergeTask('Pull Request gate for Plan A');
    expect(mergeGatePanelHeading(task, 'github')).toBe('GitHub PR gate for Plan A');
  });

  it('rewrites other prefixed gates to GitHub PR gate when mergeMode is github', () => {
    const task = mergeTask('Merge gate for Plan B');
    expect(mergeGatePanelHeading(task, 'github')).toBe('GitHub PR gate for Plan B');
  });

  it('does not rewrite when mergeMode is manual', () => {
    const task = mergeTask('Pull request gate for Plan A');
    expect(mergeGatePanelHeading(task, 'manual')).toBe('Pull request gate for Plan A');
  });

  it('rewrites when prUrl is set even if mergeMode is unset', () => {
    const task = mergeTask('Pull request gate for Plan A', {
      prUrl: 'https://github.com/o/r/pull/1',
    });
    expect(mergeGatePanelHeading(task, undefined)).toBe('GitHub PR gate for Plan A');
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

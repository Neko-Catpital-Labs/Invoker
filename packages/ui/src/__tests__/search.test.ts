import { describe, it, expect } from 'vitest';
import { computeSearchResults, normalizedSearchText } from '../lib/search.js';
import type { TaskState, WorkflowMeta } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { id: string; workflowId?: string }): TaskState {
  const { workflowId, ...rest } = overrides;
  return {
    description: `desc-${overrides.id}`,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: workflowId ? { workflowId } : {},
    execution: {},
    taskStateVersion: 1,
    ...rest,
  } as TaskState;
}

function makeWorkflow(overrides: Partial<WorkflowMeta> & { id: string }): WorkflowMeta {
  return {
    name: `Workflow ${overrides.id}`,
    status: 'pending',
    ...overrides,
  } as WorkflowMeta;
}

describe('normalizedSearchText', () => {
  it('lowercases and coerces nullish to empty string', () => {
    expect(normalizedSearchText('AbC')).toBe('abc');
    expect(normalizedSearchText(undefined)).toBe('');
    expect(normalizedSearchText('')).toBe('');
  });
});

describe('computeSearchResults', () => {
  it('returns [] for empty or whitespace-only queries', () => {
    const tasks = new Map([['t1', makeTask({ id: 't1' })]]);
    const workflows = new Map([['w1', makeWorkflow({ id: 'w1' })]]);
    expect(computeSearchResults('', tasks, workflows)).toEqual([]);
    expect(computeSearchResults('   ', tasks, workflows)).toEqual([]);
  });

  it('matches workflow by name (case insensitive)', () => {
    const tasks = new Map<string, TaskState>();
    const workflows = new Map([
      ['w1', makeWorkflow({ id: 'w1', name: 'Deploy Prod' })],
      ['w2', makeWorkflow({ id: 'w2', name: 'Nightly Cron' })],
    ]);
    const results = computeSearchResults('deploy', tasks, workflows);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ kind: 'workflow', id: 'w1', title: 'Deploy Prod' });
  });

  it('matches task by description and workflow relation', () => {
    const tasks = new Map([
      ['t1', makeTask({ id: 't1', description: 'build the frontend', workflowId: 'w1' })],
      ['t2', makeTask({ id: 't2', description: 'run smoke test', workflowId: 'w1' })],
    ]);
    const workflows = new Map([['w1', makeWorkflow({ id: 'w1', name: 'CI' })]]);
    const results = computeSearchResults('frontend', tasks, workflows);
    expect(results).toEqual([
      {
        kind: 'task',
        id: 't1',
        workflowId: 'w1',
        title: 'build the frontend',
        subtitle: 'Task · CI',
      },
    ]);
  });

  it('caps results at 12', () => {
    const workflows = new Map<string, WorkflowMeta>();
    const tasks = new Map<string, TaskState>();
    for (let i = 0; i < 20; i += 1) {
      tasks.set(`t${i}`, makeTask({ id: `t${i}`, description: `matching-${i}` }));
    }
    const results = computeSearchResults('matching', tasks, workflows);
    expect(results).toHaveLength(12);
  });

  it('uses a per-workflow task index rather than scanning all tasks per workflow', () => {
    const workflows = new Map<string, WorkflowMeta>();
    const tasks = new Map<string, TaskState>();
    for (let w = 0; w < 5; w += 1) {
      const wid = `w${w}`;
      workflows.set(wid, makeWorkflow({ id: wid, name: `WF-${w}` }));
      for (let t = 0; t < 20; t += 1) {
        const tid = `${wid}-t${t}`;
        tasks.set(tid, makeTask({
          id: tid,
          description: `task ${tid}`,
          workflowId: wid,
          execution: t === 0 ? { reviewUrl: `https://example.com/${wid}` } : {},
        }));
      }
    }
    const results = computeSearchResults('example.com/w2', tasks, workflows);
    expect(results.some((r) => r.kind === 'workflow' && r.id === 'w2')).toBe(true);
  });
});

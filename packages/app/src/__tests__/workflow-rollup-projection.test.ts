import { describe, expect, it } from 'vitest';
import { WorkflowRollupProjection } from '../workflow-rollup-projection.js';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(
  id: string,
  workflowId: string | undefined,
  status: TaskState['status'] = 'pending',
  overrides: Partial<TaskState> = {},
): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: [],
    createdAt: new Date('2025-01-01T00:00:00Z'),
    config: { workflowId, command: `echo ${id}`, runnerKind: 'worktree', ...config },
    execution: { ...execution },
    taskStateVersion: 1,
    ...rest,
  } as TaskState;
}

describe('WorkflowRollupProjection', () => {
  it('replaces the index and ignores tasks without workflow ids', () => {
    const projection = new WorkflowRollupProjection();
    projection.replaceAll([
      makeTask('wf-1/task-a', 'wf-1', 'running'),
      makeTask('standalone', undefined, 'failed'),
    ]);

    const patch = projection.patchFor('wf-1');

    expect(patch.workflowId).toBe('wf-1');
    expect(patch.status).toBe('running');
    expect(patch.rollup.countsByStatus.running).toBe(1);
    expect(projection.patchFor('standalone').status).toBe('pending');
  });

  it('returns one patch for a created task workflow', () => {
    const projection = new WorkflowRollupProjection();

    const patches = projection.applyDelta({
      type: 'created',
      task: makeTask('wf-1/task-a', 'wf-1', 'running'),
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ workflowId: 'wf-1', status: 'running' });
  });

  it('returns no created patch when the task has no workflow id', () => {
    const projection = new WorkflowRollupProjection();

    const patches = projection.applyDelta({
      type: 'created',
      task: makeTask('task-a', undefined, 'running'),
    });

    expect(patches).toEqual([]);
  });

  it('merges accepted updates and publishes status from live tasks', () => {
    const projection = new WorkflowRollupProjection();
    projection.replaceAll([makeTask('wf-1/task-a', 'wf-1', 'failed')]);

    const patches = projection.applyDelta({
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: {
        status: 'running',
        config: { command: 'echo changed' },
        execution: { branch: 'feature/live-rollup' },
      },
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ workflowId: 'wf-1', status: 'running' });
    expect(patches[0]?.rollup.countsByStatus.running).toBe(1);
  });

  it('does not patch unknown updated tasks', () => {
    const projection = new WorkflowRollupProjection();

    const patches = projection.applyDelta({
      type: 'updated',
      taskId: 'wf-1/missing',
      changes: { status: 'running' },
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
    });

    expect(patches).toEqual([]);
  });

  it('patches old and new workflow ids after a workflow move', () => {
    const projection = new WorkflowRollupProjection();
    projection.replaceAll([makeTask('task-a', 'wf-1', 'running')]);

    const patches = projection.applyDelta({
      type: 'updated',
      taskId: 'task-a',
      changes: { config: { workflowId: 'wf-2' } },
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
    });

    expect(patches.map((patch) => [patch.workflowId, patch.status])).toEqual([
      ['wf-1', 'pending'],
      ['wf-2', 'running'],
    ]);
  });

  it('returns a pending patch when the last workflow task is removed', () => {
    const projection = new WorkflowRollupProjection();
    projection.replaceAll([makeTask('wf-1/task-a', 'wf-1', 'running')]);

    const patches = projection.applyDelta({
      type: 'removed',
      taskId: 'wf-1/task-a',
      previousTaskStateVersion: 1,
    });

    expect(patches).toHaveLength(1);
    expect(patches[0]).toMatchObject({ workflowId: 'wf-1', status: 'pending' });
    expect(patches[0]?.rollup.countsByStatus.running).toBe(0);
  });

  it('does not patch unknown removed tasks', () => {
    const projection = new WorkflowRollupProjection();

    const patches = projection.applyDelta({
      type: 'removed',
      taskId: 'wf-1/missing',
      previousTaskStateVersion: 1,
    });

    expect(patches).toEqual([]);
  });
});

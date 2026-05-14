import { describe, expect, it } from 'vitest';
import { createTaskState, type TaskState } from '@invoker/workflow-graph';
import {
  INVALIDATION_POLICIES,
  planInvalidation,
  withSchedulerEnqueueCandidates,
} from '../invalidation-plan.js';

function task(
  id: string,
  workflowId: string,
  dependencies: string[] = [],
  status: TaskState['status'] = 'completed',
): TaskState {
  return {
    ...createTaskState(id, id, dependencies, {
      workflowId,
      command: `echo ${id}`,
    }),
    status,
  };
}

describe('InvalidationPlan policy registry', () => {
  it('registers invalidating recreate/retry and schedule-only policies', () => {
    expect(INVALIDATION_POLICIES.recreateWorkflow).toMatchObject({
      action: 'recreateWorkflow',
      scope: 'workflow',
      mode: 'recreate',
    });
    expect(INVALIDATION_POLICIES.recreateTask).toMatchObject({
      action: 'recreateTask',
      scope: 'task',
      mode: 'recreate',
    });
    expect(INVALIDATION_POLICIES.retryWorkflow).toMatchObject({
      action: 'retryWorkflow',
      scope: 'workflow',
      mode: 'retry',
    });
    expect(INVALIDATION_POLICIES.retryTask).toMatchObject({
      action: 'retryTask',
      scope: 'task',
      mode: 'retry',
    });
    expect(INVALIDATION_POLICIES.scheduleOnly).toMatchObject({
      action: 'scheduleOnly',
      scope: 'task',
      mode: 'scheduleOnly',
    });
  });

  it('plans workflow recreate as every task in the workflow', () => {
    const tasks = [
      task('wf-1/a', 'wf-1'),
      task('wf-1/b', 'wf-1', ['wf-1/a']),
      task('wf-2/a', 'wf-2'),
    ];

    const plan = planInvalidation({
      action: 'recreateWorkflow',
      targetId: 'wf-1',
      tasks,
    });

    expect(plan).toMatchObject({
      action: 'recreateWorkflow',
      scope: 'workflow',
      mode: 'recreate',
      affectedWorkflowIds: ['wf-1'],
      affectedTaskIds: ['wf-1/a', 'wf-1/b'],
      lockPlan: { workflowIds: ['wf-1'] },
    });
  });

  it('plans task recreate as the task plus all descendants', () => {
    const tasks = [
      task('wf-1/root', 'wf-1'),
      task('wf-1/child', 'wf-1', ['wf-1/root']),
      task('wf-1/grandchild', 'wf-1', ['wf-1/child']),
      task('wf-1/sibling', 'wf-1'),
    ];

    const plan = planInvalidation({
      action: 'recreateTask',
      targetId: 'wf-1/root',
      tasks,
    });

    expect(plan).toMatchObject({
      action: 'recreateTask',
      scope: 'task',
      mode: 'recreate',
      affectedWorkflowIds: ['wf-1'],
      affectedTaskIds: ['wf-1/child', 'wf-1/grandchild', 'wf-1/root'],
      lockPlan: { workflowIds: ['wf-1'] },
    });
  });

  it('plans task retry as the task plus non-completed descendants', () => {
    const tasks = [
      task('wf-1/root', 'wf-1', [], 'failed'),
      task('wf-1/failed-child', 'wf-1', ['wf-1/root'], 'failed'),
      task('wf-1/completed-child', 'wf-1', ['wf-1/root'], 'completed'),
      task('wf-1/after-completed', 'wf-1', ['wf-1/completed-child'], 'failed'),
    ];

    const plan = planInvalidation({
      action: 'retryTask',
      targetId: 'wf-1/root',
      tasks,
    });

    expect(plan).toMatchObject({
      action: 'retryTask',
      scope: 'task',
      mode: 'retry',
      affectedTaskIds: ['wf-1/failed-child', 'wf-1/root'],
    });
  });

  it('plans workflow retry from retryable roots and downstream retry footprint', () => {
    const retryStatuses = new Set<TaskState['status']>(['failed', 'blocked']);
    const tasks = [
      task('wf-1/root', 'wf-1', [], 'completed'),
      task('wf-1/failed', 'wf-1', ['wf-1/root'], 'failed'),
      task('wf-1/downstream', 'wf-1', ['wf-1/failed'], 'pending'),
      task('wf-1/completed-downstream', 'wf-1', ['wf-1/failed'], 'completed'),
      task('wf-2/failed', 'wf-2', [], 'failed'),
    ];

    const plan = planInvalidation({
      action: 'retryWorkflow',
      targetId: 'wf-1',
      tasks,
      retryStatuses,
    });

    expect(plan).toMatchObject({
      action: 'retryWorkflow',
      scope: 'workflow',
      mode: 'retry',
      affectedWorkflowIds: ['wf-1'],
      affectedTaskIds: ['wf-1/downstream', 'wf-1/failed'],
    });
  });

  it('plans schedule-only without invalidating active attempts', () => {
    const tasks = [
      task('wf-1/gated', 'wf-1', [], 'running'),
      task('wf-1/other', 'wf-1'),
    ];

    const plan = planInvalidation({
      action: 'scheduleOnly',
      targetId: 'wf-1/gated',
      tasks,
    });

    expect(plan).toMatchObject({
      action: 'scheduleOnly',
      scope: 'task',
      mode: 'scheduleOnly',
      affectedWorkflowIds: ['wf-1'],
      affectedTaskIds: ['wf-1/gated'],
      schedulerEnqueueCandidates: [{ taskId: 'wf-1/gated' }],
      lockPlan: { workflowIds: ['wf-1'] },
    });
  });

  it('sorts lock workflow ids deterministically', () => {
    const tasks = [
      task('z/root', 'z'),
      task('a/child', 'a', ['z/root']),
    ];

    const plan = planInvalidation({
      action: 'recreateTask',
      targetId: 'z/root',
      tasks,
    });

    expect(plan.affectedWorkflowIds).toEqual(['a', 'z']);
    expect(plan.lockPlan.workflowIds).toEqual(['a', 'z']);
  });

  it('updates scheduler enqueue candidates immutably', () => {
    const plan = planInvalidation({
      action: 'recreateWorkflow',
      targetId: 'wf-1',
      tasks: [task('wf-1/a', 'wf-1')],
    });

    const updated = withSchedulerEnqueueCandidates(plan, ['wf-1/b', 'wf-1/a', 'wf-1/a']);

    expect(plan.schedulerEnqueueCandidates).toEqual([]);
    expect(updated.schedulerEnqueueCandidates).toEqual([
      { taskId: 'wf-1/a' },
      { taskId: 'wf-1/b' },
    ]);
  });
});

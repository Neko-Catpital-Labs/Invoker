import { describe, expect, it } from 'vitest';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import { Channels } from '@invoker/transport';

import {
  WorkerLifecycleEventKinds,
  createReviewGateCiFailedLifecycleEvent,
  createTaskLifecycleEventFromDelta,
  createWorkflowWakeupLifecycleEvent,
  isWorkerLifecycleEvent,
  lifecycleEventKey,
} from '../lifecycle-events.js';

const createdAt = new Date('2026-01-02T03:04:05.000Z');

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'task 1',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
    ...overrides,
  };
}

describe('lifecycle-events', () => {
  it('defines a workflow lifecycle channel without changing existing task channels', () => {
    expect(Channels.TASK_DELTA).toBe('task.delta');
    expect(Channels.TASK_OUTPUT).toBe('task.output');
    expect(Channels.WORKFLOW_LIFECYCLE).toBe('workflow.lifecycle');
  });

  it('builds a task.created wakeup from created deltas', () => {
    const event = createTaskLifecycleEventFromDelta(
      { type: 'created', task: makeTask() },
      { createdAt },
    );

    expect(event).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_CREATED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      status: 'pending',
      taskStateVersion: 1,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(isWorkerLifecycleEvent(event)).toBe(true);
  });

  it('builds a task.updated wakeup for non-terminal updates', () => {
    const event = createTaskLifecycleEventFromDelta(
      {
        type: 'updated',
        taskId: 'wf-1/task-1',
        changes: { status: 'running' },
        previousTaskStateVersion: 1,
        taskStateVersion: 2,
      },
      {
        workflowId: 'wf-1',
        previousStatus: 'pending',
        generation: 3,
        attemptId: 'attempt-1',
        createdAt,
      },
    );

    expect(event).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_UPDATED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      status: 'running',
      previousStatus: 'pending',
      previousTaskStateVersion: 1,
      taskStateVersion: 2,
      generation: 3,
      attemptId: 'attempt-1',
    });
  });

  it('specializes task.completed and task.failed wakeups from status updates', () => {
    const completed = createTaskLifecycleEventFromDelta(
      {
        type: 'updated',
        taskId: 'wf-1/task-1',
        changes: { status: 'completed' },
        previousTaskStateVersion: 2,
        taskStateVersion: 3,
      },
      { workflowId: 'wf-1', previousStatus: 'running', createdAt },
    );
    const failed = createTaskLifecycleEventFromDelta(
      {
        type: 'updated',
        taskId: 'wf-1/task-2',
        changes: { status: 'failed' },
        previousTaskStateVersion: 4,
        taskStateVersion: 5,
      },
      { workflowId: 'wf-1', previousStatus: 'running', createdAt },
    );

    expect(completed.kind).toBe(WorkerLifecycleEventKinds.TASK_COMPLETED);
    expect(completed.status).toBe('completed');
    expect(failed.kind).toBe(WorkerLifecycleEventKinds.TASK_FAILED);
    expect(failed.status).toBe('failed');
  });

  it('builds a task.removed wakeup from removed deltas', () => {
    const event = createTaskLifecycleEventFromDelta(
      { type: 'removed', taskId: 'wf-1/task-1', previousTaskStateVersion: 8 },
      { workflowId: 'wf-1', generation: 4, attemptId: 'attempt-8', createdAt },
    );

    expect(event).toMatchObject({
      kind: WorkerLifecycleEventKinds.TASK_REMOVED,
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      taskStateVersion: 8,
      previousTaskStateVersion: 8,
      generation: 4,
      attemptId: 'attempt-8',
    });
  });

  it('builds review-gate CI failure wakeups for recovery workers', () => {
    const event = createReviewGateCiFailedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/__merge__',
      status: 'review_ready',
      taskStateVersion: 9,
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'abc123',
      headRef: 'feature/ci-red',
      branch: 'feature/ci-red',
      selectedAttemptId: 'attempt-merge',
      generation: 7,
      failedChecks: [{ name: 'test-all' }],
      statusText: 'CI failed',
    }, { createdAt });

    expect(event).toMatchObject({
      kind: WorkerLifecycleEventKinds.REVIEW_GATE_CI_FAILED,
      workflowId: 'wf-1',
      taskId: 'wf-1/__merge__',
      status: 'review_ready',
      taskStateVersion: 9,
      generation: 7,
      attemptId: 'attempt-merge',
      reviewId: '123',
      failedCheckCount: 1,
    });
    expect(isWorkerLifecycleEvent(event)).toBe(true);
  });

  it('builds workflow wakeups without task identity', () => {
    const event = createWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      reason: 'startup_reconcile',
      generation: 4,
      createdAt,
    });

    expect(event).toMatchObject({
      kind: WorkerLifecycleEventKinds.WORKFLOW_WAKEUP,
      workflowId: 'wf-1',
      reason: 'startup_reconcile',
      generation: 4,
      createdAt: '2026-01-02T03:04:05.000Z',
    });
    expect(event.taskId).toBeUndefined();
  });

  it('uses deterministic keys for idempotent worker handling', () => {
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
      previousTaskStateVersion: 2,
      taskStateVersion: 3,
    };

    const a = createTaskLifecycleEventFromDelta(delta, {
      workflowId: 'wf-1',
      generation: 5,
      attemptId: 'attempt-5',
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });
    const b = createTaskLifecycleEventFromDelta(delta, {
      workflowId: 'wf-1',
      generation: 5,
      attemptId: 'attempt-5',
      createdAt: new Date('2026-01-01T00:00:10.000Z'),
    });

    expect(a.key).toBe(b.key);
    expect(a.key).toBe(lifecycleEventKey(
      WorkerLifecycleEventKinds.TASK_FAILED,
      'wf-1',
      'wf-1/task-1',
      2,
      3,
      'failed',
      5,
      'attempt-5',
    ));
  });
});

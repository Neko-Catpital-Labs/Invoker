import { describe, it, expect } from 'vitest';
import { Channels } from '@invoker/transport';
import type { TaskDelta, TaskState } from '@invoker/workflow-core';
import {
  buildLifecycleEventFromTaskDelta,
  buildReviewGateCiFailedLifecycleEvent,
  buildTaskUpdatedLifecycleEvent,
  buildWorkflowWakeupLifecycleEvent,
  isTaskLifecycleEvent,
  isWorkflowLifecycleEvent,
  lifecycleEventKindForTaskStatus,
} from '../lifecycle-events.js';

const CREATED_AT = '2026-06-04T00:00:00.000Z';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-06-03T00:00:00.000Z'),
    config: { workflowId: 'wf-1' },
    execution: { generation: 3, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

describe('worker lifecycle channel', () => {
  it('adds workflow lifecycle without changing existing task channels', () => {
    expect(Channels.TASK_DELTA).toBe('task.delta');
    expect(Channels.TASK_OUTPUT).toBe('task.output');
    expect(Channels.WORKFLOW_LIFECYCLE).toBe('workflow.lifecycle');
  });
});

describe('lifecycle event helpers', () => {
  it('builds task.created from created deltas', () => {
    const event = buildLifecycleEventFromTaskDelta(
      { type: 'created', task: makeTask() },
      { createdAt: CREATED_AT },
    );

    expect(event).toMatchObject({
      eventKey: 'task.created|workflow:wf-1|task:wf-1/task-a|generation:3|attempt:attempt-1|task-state:1',
      kind: 'task.created',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'pending',
      taskStateVersion: 1,
      generation: 3,
      attemptId: 'attempt-1',
      createdAt: CREATED_AT,
    });
    expect(isTaskLifecycleEvent(event)).toBe(true);
  });

  it('builds task.updated from non-terminal status updates', () => {
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-a',
      changes: { status: 'running', execution: { generation: 4, selectedAttemptId: 'attempt-2' } },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    };

    const event = buildLifecycleEventFromTaskDelta(delta, {
      workflowId: 'wf-1',
      previousStatus: 'pending',
      createdAt: CREATED_AT,
    });

    expect(event).toMatchObject({
      eventKey: 'task.updated|workflow:wf-1|task:wf-1/task-a|generation:4|attempt:attempt-2|task-state:2',
      kind: 'task.updated',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'running',
      previousStatus: 'pending',
      taskStateVersion: 2,
      generation: 4,
      attemptId: 'attempt-2',
      createdAt: CREATED_AT,
    });
  });

  it('maps completed and failed status updates to worker lifecycle kinds', () => {
    expect(lifecycleEventKindForTaskStatus('completed')).toBe('task.completed');
    expect(lifecycleEventKindForTaskStatus('failed')).toBe('task.failed');

    const completed = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'completed',
      previousStatus: 'running',
      taskStateVersion: 3,
      generation: 4,
      attemptId: 'attempt-2',
      createdAt: CREATED_AT,
    });
    const failed = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-b',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 4,
      generation: 1,
      attemptId: 'attempt-3',
      createdAt: CREATED_AT,
    });

    expect(completed.kind).toBe('task.completed');
    expect(failed.kind).toBe('task.failed');
    expect(completed.eventKey).toBe('task.completed|workflow:wf-1|task:wf-1/task-a|generation:4|attempt:attempt-2|task-state:3');
    expect(failed.eventKey).toBe('task.failed|workflow:wf-1|task:wf-1/task-b|generation:1|attempt:attempt-3|task-state:4');
  });

  it('maps review readiness status updates to worker lifecycle kinds', () => {
    const reviewReady = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      previousStatus: 'running',
      taskStateVersion: 5,
      generation: 2,
      createdAt: CREATED_AT,
    });

    expect(reviewReady.kind).toBe('task.review_ready');
  });

  it('maps needs_input status updates to worker lifecycle kinds', () => {
    const needsInput = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'needs_input',
      previousStatus: 'running',
      taskStateVersion: 6,
      generation: 2,
      createdAt: CREATED_AT,
    });

    expect(lifecycleEventKindForTaskStatus('needs_input')).toBe('task.needs_input');
    expect(needsInput.kind).toBe('task.needs_input');
    expect(isWorkflowLifecycleEvent(needsInput)).toBe(true);
  });

  it('builds task.removed from removed deltas', () => {
    const event = buildLifecycleEventFromTaskDelta(
      { type: 'removed', taskId: 'wf-1/task-a', previousTaskStateVersion: 9 },
      {
        workflowId: 'wf-1',
        previousStatus: 'failed',
        generation: 6,
        attemptId: 'attempt-9',
        createdAt: CREATED_AT,
      },
    );

    expect(event).toMatchObject({
      eventKey: 'task.removed|workflow:wf-1|task:wf-1/task-a|generation:6|attempt:attempt-9|task-state:9',
      kind: 'task.removed',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      previousStatus: 'failed',
      taskStateVersion: 9,
      generation: 6,
      attemptId: 'attempt-9',
      createdAt: CREATED_AT,
    });
  });

  it('builds review_gate.ci_failed lifecycle wakeups', () => {
    const event = buildReviewGateCiFailedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      taskStateVersion: 12,
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'abc123',
      headRef: 'feature/ci-red',
      branch: 'feature/ci-red',
      failedChecks: [
        { name: 'test-all', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/1' },
      ],
      statusText: 'CI failed',
      generation: 7,
      attemptId: 'attempt-merge',
      createdAt: CREATED_AT,
    });

    expect(event).toMatchObject({
      eventKey: 'review_gate.ci_failed|workflow:wf-1|task:wf-1/merge|generation:7|attempt:attempt-merge|task-state:12|review:123:abc123',
      kind: 'review_gate.ci_failed',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      taskStateVersion: 12,
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      headSha: 'abc123',
      generation: 7,
      attemptId: 'attempt-merge',
      createdAt: CREATED_AT,
      statusText: 'CI failed',
    });
    expect(event.failedChecks).toEqual([
      { name: 'test-all', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/runs/1' },
    ]);
    expect(isWorkflowLifecycleEvent(event)).toBe(true);
  });

  it('builds workflow.wakeup events for persisted-state reconciliation', () => {
    const event = buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      status: 'running',
      generation: 8,
      reason: 'stalled_workflow_recovery',
      createdAt: CREATED_AT,
    });

    expect(event).toEqual({
      eventKey: 'workflow.wakeup|workflow:wf-1|generation:8|reason:stalled_workflow_recovery',
      kind: 'workflow.wakeup',
      workflowId: 'wf-1',
      status: 'running',
      generation: 8,
      createdAt: CREATED_AT,
      reason: 'stalled_workflow_recovery',
    });
    expect(isWorkflowLifecycleEvent(event)).toBe(true);
  });

  it('rejects malformed lifecycle events', () => {
    expect(isWorkflowLifecycleEvent({ kind: 'task.failed' })).toBe(false);
    expect(isWorkflowLifecycleEvent({ ...buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      generation: 1,
      reason: 'manual_reconcile',
      createdAt: CREATED_AT,
    }), generation: '1' })).toBe(false);
  });
});

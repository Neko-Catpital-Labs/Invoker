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
  lifecycleEventMatchesPersistedTask,
  lifecycleEventKindForTaskStatus,
} from '../lifecycle-events.js';

const CREATED_AT = '2026-06-04T00:00:00.000Z';
const CREATED_AT_DATE = new Date(CREATED_AT);

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

function expectRecoveryWakeup(event: any, expected: Record<string, unknown>): void {
  expect(event.recoveryWakeup).toEqual({
    eventKey: event.eventKey,
    eventKind: event.kind,
    workflowId: event.workflowId,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    ...(event.taskStateVersion != null ? { taskStateVersion: event.taskStateVersion } : {}),
    generation: event.generation,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    createdAt: event.createdAt,
    authoritative: false,
    ...expected,
  });
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
      { createdAt: CREATED_AT_DATE },
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
    expectRecoveryWakeup(event, { reason: 'task_lifecycle' });
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
      createdAt: CREATED_AT_DATE,
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
    expectRecoveryWakeup(event, { reason: 'task_lifecycle' });
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
      createdAt: CREATED_AT_DATE,
    });
    const failed = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-b',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 4,
      generation: 1,
      attemptId: 'attempt-3',
      createdAt: CREATED_AT_DATE,
    });

    expect(completed.kind).toBe('task.completed');
    expect(failed.kind).toBe('task.failed');
    expect(completed.eventKey).toBe('task.completed|workflow:wf-1|task:wf-1/task-a|generation:4|attempt:attempt-2|task-state:3');
    expect(failed.eventKey).toBe('task.failed|workflow:wf-1|task:wf-1/task-b|generation:1|attempt:attempt-3|task-state:4');
    expectRecoveryWakeup(completed, { reason: 'task_lifecycle' });
    expectRecoveryWakeup(failed, { reason: 'task_failure' });
  });

  it('maps review readiness status updates to worker lifecycle kinds', () => {
    const reviewReady = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      previousStatus: 'running',
      taskStateVersion: 5,
      generation: 2,
      createdAt: CREATED_AT_DATE,
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
      createdAt: CREATED_AT_DATE,
    });

    expect(lifecycleEventKindForTaskStatus('needs_input')).toBe('task.needs_input');
    expect(needsInput.kind).toBe('task.needs_input');
    expect(isWorkflowLifecycleEvent(needsInput)).toBe(true);
    expectRecoveryWakeup(needsInput, { reason: 'task_lifecycle' });
  });

  it('builds task.removed from removed deltas', () => {
    const event = buildLifecycleEventFromTaskDelta(
      { type: 'removed', taskId: 'wf-1/task-a', previousTaskStateVersion: 9 },
      {
        workflowId: 'wf-1',
        previousStatus: 'failed',
        generation: 6,
        attemptId: 'attempt-9',
        createdAt: CREATED_AT_DATE,
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
    expectRecoveryWakeup(event, { reason: 'task_lifecycle' });
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
      createdAt: CREATED_AT_DATE,
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
    expectRecoveryWakeup(event, { reason: 'review_gate_failure' });
  });

  it('builds workflow.wakeup events for persisted-state reconciliation', () => {
    const event = buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      status: 'running',
      generation: 8,
      reason: 'stalled_workflow_recovery',
      createdAt: CREATED_AT_DATE,
    });

    expect(event).toEqual({
      eventKey: 'workflow.wakeup|workflow:wf-1|generation:8|reason:stalled_workflow_recovery',
      kind: 'workflow.wakeup',
      workflowId: 'wf-1',
      status: 'running',
      generation: 8,
      createdAt: CREATED_AT,
      recoveryWakeup: {
        eventKey: 'workflow.wakeup|workflow:wf-1|generation:8|reason:stalled_workflow_recovery',
        eventKind: 'workflow.wakeup',
        workflowId: 'wf-1',
        generation: 8,
        createdAt: CREATED_AT,
        reason: 'workflow_reconcile',
        authoritative: false,
      },
      reason: 'stalled_workflow_recovery',
    });
    expect(isWorkflowLifecycleEvent(event)).toBe(true);
  });

  it('defaults omitted createdAt values to canonical UTC ISO timestamps', () => {
    const event = buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      generation: 1,
      reason: 'manual_reconcile',
    });

    expect(event.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(isWorkflowLifecycleEvent(event)).toBe(true);
  });

  it('rejects non-Date createdAt values at lifecycle builder boundaries', () => {
    const invalidCreatedAtValues = [
      '2026-06-04T00:00:00Z',
      '2026-06-04T00:00:00.000+00:00',
      'not-a-date',
      123,
      new Date('not-a-date'),
    ];

    for (const createdAt of invalidCreatedAtValues) {
      expect(() => buildTaskUpdatedLifecycleEvent({
        workflowId: 'wf-1',
        taskId: 'wf-1/task-a',
        status: 'failed',
        taskStateVersion: 1,
        generation: 1,
        createdAt: createdAt as Date,
      })).toThrow(/createdAt must be a valid Date/);
    }

    expect(() => buildReviewGateCiFailedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      status: 'review_ready',
      taskStateVersion: 12,
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      failedChecks: [],
      statusText: 'CI failed',
      generation: 7,
      createdAt: '2026-06-04T00:00:00Z' as unknown as Date,
    })).toThrow(/createdAt must be a valid Date/);

    expect(() => buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      generation: 1,
      reason: 'manual_reconcile',
      createdAt: '2026-06-04T00:00:00Z' as unknown as Date,
    })).toThrow(/createdAt must be a valid Date/);
  });

  it('marks recovery wakeup data as non-authoritative optimization hints', () => {
    const event = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 10,
      generation: 5,
      attemptId: 'attempt-stale',
      createdAt: CREATED_AT_DATE,
    });

    expect(event.recoveryWakeup).toMatchObject({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      generation: 5,
      attemptId: 'attempt-stale',
      taskStateVersion: 10,
      authoritative: false,
    });
  });

  it('requires persisted task generation, attempt, and state version checks for wakeups', () => {
    const event = buildTaskUpdatedLifecycleEvent({
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      status: 'failed',
      previousStatus: 'running',
      taskStateVersion: 10,
      generation: 5,
      attemptId: 'attempt-current',
      createdAt: CREATED_AT_DATE,
    });

    expect(lifecycleEventMatchesPersistedTask(event, makeTask({
      status: 'failed',
      taskStateVersion: 10,
      execution: { generation: 5, selectedAttemptId: 'attempt-current' },
    }))).toBe(true);
    expect(lifecycleEventMatchesPersistedTask(event, makeTask({
      status: 'failed',
      taskStateVersion: 10,
      execution: { generation: 6, selectedAttemptId: 'attempt-current' },
    }))).toBe(false);
    expect(lifecycleEventMatchesPersistedTask(event, makeTask({
      status: 'failed',
      taskStateVersion: 10,
      execution: { generation: 5, selectedAttemptId: 'attempt-next' },
    }))).toBe(false);
    expect(lifecycleEventMatchesPersistedTask(event, makeTask({
      status: 'failed',
      taskStateVersion: 11,
      execution: { generation: 5, selectedAttemptId: 'attempt-current' },
    }))).toBe(false);
  });

  it('rejects malformed lifecycle events', () => {
    expect(isWorkflowLifecycleEvent({ kind: 'task.failed' })).toBe(false);
    expect(isWorkflowLifecycleEvent({ ...buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      generation: 1,
      reason: 'manual_reconcile',
      createdAt: CREATED_AT_DATE,
    }), generation: '1' })).toBe(false);
    expect(isWorkflowLifecycleEvent({ ...buildWorkflowWakeupLifecycleEvent({
      workflowId: 'wf-1',
      generation: 1,
      reason: 'manual_reconcile',
      createdAt: CREATED_AT_DATE,
    }), createdAt: '2026-06-04T00:00:00Z' })).toBe(false);
    expect(isWorkflowLifecycleEvent({
      ...buildTaskUpdatedLifecycleEvent({
        workflowId: 'wf-1',
        taskId: 'wf-1/task-a',
        status: 'failed',
        taskStateVersion: 1,
        generation: 1,
        createdAt: CREATED_AT_DATE,
      }),
      recoveryWakeup: { authoritative: true },
    })).toBe(false);
  });
});

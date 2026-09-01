import { describe, expect, it } from 'vitest';
import { TASK_STATUSES, type TaskStatus, type WorkflowDerivedStatus } from '@invoker/workflow-core';

import {
  decideWorkflowRetirement,
  hasActiveOrUnknownTask,
  WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS,
} from '../workers/idle-task-cleanup-policy.js';

const NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const JUST_OVER_48_HOURS_AGO = new Date(NOW - WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS - 1).toISOString();

function decide(
  status: string,
  updatedAt: string | Date,
  taskStatuses: string[],
) {
  return decideWorkflowRetirement(
    { status, updatedAt },
    taskStatuses.map((taskStatus) => ({ status: taskStatus })),
    { now: NOW },
  );
}

describe('decideWorkflowRetirement', () => {
  it.each<TaskStatus>(['completed', 'failed', 'closed', 'stale'])(
    'retires a completed workflow immediately when its task is %s',
    (taskStatus) => {
      expect(decide('completed', new Date(NOW), [taskStatus])).toEqual({
        kind: 'retire',
        reason: 'completed',
      });
    },
  );

  it.each<WorkflowDerivedStatus>([
    'pending',
    'running',
    'fixing_with_ai',
    'failed',
    'closed',
    'blocked',
    'review_ready',
    'awaiting_approval',
    'stale',
  ])('retires a %s workflow only after more than 48 inactive hours', (status) => {
    expect(decide(status, JUST_OVER_48_HOURS_AGO, ['failed'])).toEqual({
      kind: 'retire',
      reason: 'inactive-over-threshold',
    });
    expect(decide(
      status,
      new Date(NOW - WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS),
      ['failed'],
    )).toEqual({ kind: 'retain' });
  });

  it.each<TaskStatus>([
    'pending',
    'queued',
    'running',
    'fixing_with_ai',
    'needs_input',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ])('retains a completed workflow with active %s work', (taskStatus) => {
    expect(decide('completed', JUST_OVER_48_HOURS_AGO, [taskStatus])).toEqual({ kind: 'retain' });
  });

  it.each<TaskStatus>([
    'completed',
    'failed',
    'closed',
    'stale',
  ])('retires an old known workflow with inactive %s work', (taskStatus) => {
    expect(decide('failed', JUST_OVER_48_HOURS_AGO, [taskStatus])).toEqual({
      kind: 'retire',
      reason: 'inactive-over-threshold',
    });
  });

  it.each<TaskStatus>([
    'pending',
    'queued',
    'needs_input',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ])('retires an old known workflow with inert %s work', (taskStatus) => {
    expect(decide('failed', JUST_OVER_48_HOURS_AGO, [taskStatus])).toEqual({
      kind: 'retire',
      reason: 'inactive-over-threshold',
    });
  });

  it.each<TaskStatus>(['running', 'fixing_with_ai'])(
    'retains an old workflow with executing %s work',
    (taskStatus) => {
      expect(decide('failed', JUST_OVER_48_HOURS_AGO, [taskStatus])).toEqual({ kind: 'retain' });
    },
  );

  it('retains an old workflow when any task is executing', () => {
    expect(decide('failed', JUST_OVER_48_HOURS_AGO, ['failed', 'running'])).toEqual({
      kind: 'retain',
    });
  });

  it('retains unknown workflow and task statuses', () => {
    expect(decide('future_workflow_state', JUST_OVER_48_HOURS_AGO, ['failed']))
      .toEqual({ kind: 'retain' });
    expect(decide('completed', JUST_OVER_48_HOURS_AGO, ['future_task_state']))
      .toEqual({ kind: 'retain' });
    expect(decide('failed', JUST_OVER_48_HOURS_AGO, ['future_task_state']))
      .toEqual({ kind: 'retain' });
  });

  it('retains missing, malformed, and future activity timestamps', () => {
    expect(decideWorkflowRetirement(
      { status: 'failed' },
      [{ status: 'failed' }],
      { now: NOW },
    )).toEqual({ kind: 'retain' });
    expect(decide('failed', 'not-a-date', ['failed'])).toEqual({ kind: 'retain' });
    expect(decide('failed', new Date(NOW + 1), ['failed'])).toEqual({ kind: 'retain' });
  });

  it('uses a caller-supplied inactivity threshold without changing strict-boundary behavior', () => {
    const threshold = 1_000;
    expect(decideWorkflowRetirement(
      { status: 'failed', updatedAt: new Date(NOW - threshold) },
      [{ status: 'failed' }],
      { now: NOW, idleThresholdMs: threshold },
    )).toEqual({ kind: 'retain' });
    expect(decideWorkflowRetirement(
      { status: 'failed', updatedAt: new Date(NOW - threshold - 1) },
      [{ status: 'failed' }],
      { now: NOW, idleThresholdMs: threshold },
    )).toEqual({ kind: 'retire', reason: 'inactive-over-threshold' });
  });
});

describe('hasActiveOrUnknownTask', () => {
  it('classifies every current task status into the retention matrix', () => {
    const inactiveStatuses = new Set<TaskStatus>(['completed', 'failed', 'closed', 'stale']);

    for (const status of TASK_STATUSES) {
      expect(hasActiveOrUnknownTask([{ status }])).toBe(!inactiveStatuses.has(status));
    }
  });

  it('treats a missing or unknown task status as active', () => {
    expect(hasActiveOrUnknownTask([{}])).toBe(true);
    expect(hasActiveOrUnknownTask([{ status: 'future_task_state' }])).toBe(true);
  });
});

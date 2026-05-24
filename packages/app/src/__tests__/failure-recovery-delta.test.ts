import { describe, expect, it, vi } from 'vitest';
import type { TaskDelta } from '@invoker/workflow-core';

import {
  FAILURE_RECOVERY_EVENT,
  handleFailedTaskDelta,
} from '../failure-recovery-delta.js';
import type {
  ExternalFailureRecoveryLauncher,
  ExternalFailureRecoveryResult,
} from '../external-failure-recovery.js';

function makeLauncher(
  result: ExternalFailureRecoveryResult = { launched: true },
): { trigger: ReturnType<typeof vi.fn>; launcher: ExternalFailureRecoveryLauncher } {
  const trigger = vi.fn().mockReturnValue(result);
  return { trigger, launcher: { trigger } };
}

const baseContext = {
  repoRoot: '/repo',
  dbDir: '/db',
  workflowIdForTask: (taskId: string) =>
    taskId.includes('/') ? taskId.split('/')[0] : undefined,
};

describe('handleFailedTaskDelta', () => {
  it('ignores non-failed deltas', () => {
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'running' },
    };
    const outcome = handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    expect(outcome).toEqual({ handled: false, reason: 'not-failed-delta' });
    expect(trigger).not.toHaveBeenCalled();
    expect(logEvent).not.toHaveBeenCalled();
  });

  it('skips cancellation errors and logs the reason', () => {
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: {
        status: 'failed',
        execution: { error: 'Cancelled by user (workflow)' },
      },
    };
    const outcome = handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    expect(outcome).toEqual({ handled: false, reason: 'cancellation' });
    expect(trigger).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('wf-1/task-1', FAILURE_RECOVERY_EVENT, {
      phase: 'skip',
      reason: 'cancellation',
    });
  });

  it('skips when no workflow id is resolvable', () => {
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'orphan',
      changes: { status: 'failed' },
    };
    const outcome = handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    expect(outcome).toEqual({ handled: false, reason: 'workflow-not-found' });
    expect(trigger).not.toHaveBeenCalled();
    expect(logEvent).toHaveBeenCalledWith('orphan', FAILURE_RECOVERY_EVENT, {
      phase: 'skip',
      reason: 'workflow-not-found',
    });
  });

  it('passes the failed task and workflow context to the launcher', () => {
    const logEvent = vi.fn();
    const { trigger, launcher } = makeLauncher({ launched: true });
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-7/task-42',
      changes: { status: 'failed' },
    };
    const outcome = handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    expect(outcome).toEqual({ handled: true, result: { launched: true } });
    expect(trigger).toHaveBeenCalledWith({
      failedTaskId: 'wf-7/task-42',
      failedWorkflowId: 'wf-7',
      repoRoot: '/repo',
      dbDir: '/db',
    });
    expect(logEvent).toHaveBeenCalledWith('wf-7/task-42', FAILURE_RECOVERY_EVENT, {
      phase: 'delta-failed',
      failedWorkflowId: 'wf-7',
    });
    expect(logEvent).toHaveBeenCalledWith('wf-7/task-42', FAILURE_RECOVERY_EVENT, {
      phase: 'launched',
      failedWorkflowId: 'wf-7',
    });
  });

  it('records skipped launches with the launcher reason', () => {
    const logEvent = vi.fn();
    const { trigger: _trigger, launcher } = makeLauncher({
      launched: false,
      reason: 'cooldown',
    });
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    };
    const outcome = handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    expect(outcome).toEqual({
      handled: true,
      result: { launched: false, reason: 'cooldown' },
    });
    expect(logEvent).toHaveBeenCalledWith('wf-1/task-1', FAILURE_RECOVERY_EVENT, {
      phase: 'skipped',
      failedWorkflowId: 'wf-1',
      reason: 'cooldown',
    });
  });

  it('never emits debug.auto-fix events on the new path', () => {
    const logEvent = vi.fn();
    const { launcher } = makeLauncher();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'wf-1/task-1',
      changes: { status: 'failed' },
    };
    handleFailedTaskDelta(delta, {
      persistence: { logEvent },
      launcher,
      context: baseContext,
    });
    const eventTypes = logEvent.mock.calls.map(([, type]) => type);
    expect(eventTypes).not.toContain('debug.auto-fix');
  });
});

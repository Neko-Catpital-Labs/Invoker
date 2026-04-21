import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent } from '@invoker/data-store';
import { getAutoFixDispatchDecision, getAutoFixEnqueueDecision } from '../auto-fix-session.js';

function makeIntent(overrides: Partial<WorkflowMutationIntent> = {}): WorkflowMutationIntent {
  return {
    id: 1,
    workflowId: 'wf-1',
    channel: 'invoker:fix-with-agent',
    args: ['wf-1/task-1', null],
    priority: 'normal',
    status: 'queued',
    ownerId: null,
    error: null,
    createdAt: new Date(),
    startedAt: null,
    completedAt: null,
    ...overrides,
  };
}

describe('auto-fix-session', () => {
  it('does not enqueue another live auto-fix intent for the same task', () => {
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => ({ id: 'wf-1/task-1', status: 'failed', execution: { autoFixAttempts: 0 } })),
    };
    const persistence = {
      listWorkflowMutationIntents: vi.fn(() => [makeIntent({ id: 7 })]),
    };

    expect(getAutoFixEnqueueDecision(orchestrator as any, persistence as any, 'wf-1', 'wf-1/task-1')).toEqual({
      shouldEnqueue: false,
      reason: 'already-live-intent',
      status: 'failed',
      existingIntentIds: [7],
    });
  });

  it('skips stale auto-fix dispatch after the task leaves failed state', () => {
    const orchestrator = {
      shouldAutoFix: vi.fn(() => false),
      getTask: vi.fn(() => ({ id: 'wf-1/task-1', status: 'review_ready', execution: { autoFixAttempts: 1 } })),
    };

    expect(getAutoFixDispatchDecision(orchestrator as any, 'wf-1/task-1')).toEqual({
      shouldDispatch: false,
      reason: 'shouldAutoFix-false',
      status: 'review_ready',
      autoFixAttempts: 1,
    });
  });

  it('allows dispatch when the task is still failed and auto-fix eligible', () => {
    const task = { id: 'wf-1/task-1', status: 'failed', execution: { autoFixAttempts: 1 } };
    const orchestrator = {
      shouldAutoFix: vi.fn(() => true),
      getTask: vi.fn(() => task),
    };

    expect(getAutoFixDispatchDecision(orchestrator as any, 'wf-1/task-1')).toEqual({
      shouldDispatch: true,
      task,
    });
  });
});

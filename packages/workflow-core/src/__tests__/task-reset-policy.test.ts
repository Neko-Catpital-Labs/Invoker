import { describe, expect, it } from 'vitest';
import { createTaskState, type TaskExecution, type TaskState } from '@invoker/workflow-graph';
import {
  TASK_EXECUTION_RESET_RULES,
  assertResetComplete,
  buildTaskResetChanges,
  buildTaskResetExecutionPatch,
} from '../task-reset-policy.js';
const _compileTimeCoversEveryExecutionField: Record<keyof TaskExecution, unknown> = TASK_EXECUTION_RESET_RULES;
void _compileTimeCoversEveryExecutionField;

const expectedExecutionFields = [
  'generation',
  'blockedBy',
  'inputPrompt',
  'exitCode',
  'error',
  'protocolErrorCode',
  'protocolErrorMessage',
  'startedAt',
  'completedAt',
  'lastHeartbeatAt',
  'remoteHeartbeatAt',
  'heartbeatSource',
  'actionRequestId',
  'branch',
  'commit',
  'fixedIntegrationSha',
  'fixedIntegrationRecordedAt',
  'fixedIntegrationSource',
  'agentSessionId',
  'lastAgentSessionId',
  'agentName',
  'lastAgentName',
  'workspacePath',
  'containerId',
  'experiments',
  'selectedExperiment',
  'selectedExperiments',
  'experimentResults',
  'pendingFixError',
  'isFixingWithAI',
  'reviewUrl',
  'reviewId',
  'reviewStatus',
  'reviewProviderId',
  'phase',
  'launchStartedAt',
  'launchCompletedAt',
  'mergeConflict',
  'selectedAttemptId',
  'autoFixAttempts',
].sort();



function taskWithExecution(status: TaskState['status'], execution: Partial<TaskExecution>): TaskState {
  const task = createTaskState('task-1', 'Task 1', []);
  return {
    ...task,
    status,
    execution: { ...task.execution, ...execution },
  };
}

function applyReset(
  before: TaskState,
  changes: ReturnType<typeof buildTaskResetChanges>,
): TaskState {
  return {
    ...before,
    status: changes.status ?? before.status,
    config: { ...before.config, ...changes.config },
    execution: { ...before.execution, ...changes.execution },
    taskStateVersion: before.taskStateVersion + 1,
  };
}

describe('task reset policy', () => {
  it('has a rule for every TaskExecution field', () => {
    expect(Object.keys(TASK_EXECUTION_RESET_RULES).sort()).toEqual(expectedExecutionFields);
  });

  it('keeps recreate as a fresh-lineage reset without clearing fix-only fields', () => {
    const patch = buildTaskResetChanges('recreate', { config: { summary: undefined } });
    const patchKeys = Object.keys(patch.execution ?? {});

    expect(patch.status).toBe('pending');
    expect(patch.config).toEqual({ summary: undefined });
    expect(patch.execution).toMatchObject({
      autoFixAttempts: 0,
      branch: undefined,
      commit: undefined,
      workspacePath: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      agentSessionId: undefined,
      containerId: undefined,
      reviewUrl: undefined,
      reviewId: undefined,
      reviewStatus: undefined,
      reviewProviderId: undefined,
    });
    expect(patchKeys).not.toContain('pendingFixError');
    expect(patchKeys).not.toContain('blockedBy');
    expect(patchKeys).not.toContain('selectedAttemptId');
    expect(patchKeys).not.toContain('fixedIntegrationSha');
  });

  it('keeps retryTask lineage context but clears volatile task attempt state', () => {
    const patch = buildTaskResetExecutionPatch('retryTask');
    const patchKeys = Object.keys(patch);

    expect(patch).toMatchObject({
      autoFixAttempts: 0,
      commit: undefined,
      pendingFixError: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      isFixingWithAI: false,
      agentSessionId: undefined,
      containerId: undefined,
    });
    expect(patchKeys).not.toContain('branch');
    expect(patchKeys).not.toContain('workspacePath');
    expect(patchKeys).not.toContain('selectedAttemptId');
    expect(patchKeys).not.toContain('reviewUrl');
    expect(patchKeys).not.toContain('fixedIntegrationSha');
  });

  it('keeps retryWorkflow work context while clearing workflow retry failure state', () => {
    const patch = buildTaskResetExecutionPatch('retryWorkflow');
    const patchKeys = Object.keys(patch);

    expect(patch).toMatchObject({
      autoFixAttempts: 0,
      pendingFixError: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      isFixingWithAI: false,
    });
    expect(patchKeys).not.toContain('branch');
    expect(patchKeys).not.toContain('commit');
    expect(patchKeys).not.toContain('workspacePath');
    expect(patchKeys).not.toContain('agentSessionId');
    expect(patchKeys).not.toContain('containerId');
    expect(patchKeys).not.toContain('blockedBy');
  });

  it('keeps detach as the broad downstream reset', () => {
    const patch = buildTaskResetExecutionPatch('detach');
    const patchKeys = Object.keys(patch);

    expect(patch).toMatchObject({
      autoFixAttempts: 0,
      blockedBy: undefined,
      branch: undefined,
      commit: undefined,
      workspacePath: undefined,
      pendingFixError: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      isFixingWithAI: false,
      agentSessionId: undefined,
      containerId: undefined,
      reviewUrl: undefined,
      reviewId: undefined,
      reviewStatus: undefined,
      reviewProviderId: undefined,
      fixedIntegrationSha: undefined,
      fixedIntegrationRecordedAt: undefined,
      fixedIntegrationSource: undefined,
    });
    expect(patchKeys).not.toContain('selectedAttemptId');
  });

  it('lets prepareTaskForNewAttempt provide the fresh selected attempt id', () => {
    const patch = buildTaskResetExecutionPatch('newAttempt', { selectedAttemptId: 'attempt-next' });
    const patchKeys = Object.keys(patch);

    expect(patch).toMatchObject({
      selectedAttemptId: 'attempt-next',
      branch: undefined,
      commit: undefined,
      workspacePath: undefined,
      pendingFixError: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
      isFixingWithAI: false,
      agentSessionId: undefined,
      containerId: undefined,
    });
    expect(patchKeys).not.toContain('blockedBy');
    expect(patchKeys).not.toContain('reviewUrl');
    expect(patchKeys).not.toContain('fixedIntegrationSha');
  });

  it('keeps pending reset paths separate from retry and recreate resets', () => {
    expect(buildTaskResetExecutionPatch('defer')).toEqual({
      startedAt: undefined,
      lastHeartbeatAt: undefined,
      phase: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
    });
    expect(buildTaskResetExecutionPatch('readyUnblock')).toEqual({
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeatAt: undefined,
      phase: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
    });
    expect(buildTaskResetExecutionPatch('externalUnblock')).toEqual({
      blockedBy: undefined,
      startedAt: undefined,
      completedAt: undefined,
      lastHeartbeatAt: undefined,
      phase: undefined,
      launchStartedAt: undefined,
      launchCompletedAt: undefined,
    });
  });

  it('throws with the reset kind and field name when a cleared field survives', () => {
    const before = taskWithExecution('failed', {
      generation: 1,
      error: 'boom',
      agentSessionId: 'session-stale',
    });
    const after = applyReset(before, buildTaskResetChanges('retryTask', {
      execution: { generation: 2 },
    }));
    const badAfter = {
      ...after,
      execution: { ...after.execution, error: 'boom' },
    };

    expect(() => assertResetComplete(before, badAfter, 'retryTask', { execution: { generation: 2 } }))
      .toThrow(/retryTask.*execution\.error/);
  });

  it('throws with the reset kind and field name when status is not pending', () => {
    const before = taskWithExecution('failed', { generation: 1, error: 'boom' });
    const after = applyReset(before, buildTaskResetChanges('retryTask', {
      execution: { generation: 2 },
    }));
    const badAfter = { ...after, status: 'failed' as const };

    expect(() => assertResetComplete(before, badAfter, 'retryTask', { execution: { generation: 2 } }))
      .toThrow(/retryTask.*status/);
  });

  it('accepts a complete retry reset with a generation override', () => {
    const before = taskWithExecution('failed', {
      generation: 4,
      branch: 'feature',
      workspacePath: '/tmp/work',
      error: 'boom',
      exitCode: 1,
      pendingFixError: 'fix failed',
      isFixingWithAI: true,
      agentSessionId: 'session-stale',
      containerId: 'container-stale',
      autoFixAttempts: 3,
    });
    const changes = buildTaskResetChanges('retryTask', {
      execution: { generation: 5 },
    });
    const after = applyReset(before, changes);

    expect(() => assertResetComplete(before, after, 'retryTask', { execution: changes.execution }))
      .not.toThrow();
  });

  it('accepts a newAttempt reset with fresh selectedAttemptId and generation overrides', () => {
    const before = taskWithExecution('running', {
      generation: 7,
      selectedAttemptId: 'attempt-old',
      inputPrompt: 'question',
      branch: 'old-branch',
      workspacePath: '/tmp/old',
      isFixingWithAI: true,
    });
    const changes = buildTaskResetChanges('newAttempt', {
      execution: {
        generation: 8,
        selectedAttemptId: 'attempt-new',
      },
    });
    const after = applyReset(before, changes);

    expect(() => assertResetComplete(before, after, 'newAttempt', { execution: changes.execution }))
      .not.toThrow();
  });
});


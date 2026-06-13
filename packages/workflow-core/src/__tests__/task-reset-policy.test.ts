import { describe, expect, it } from 'vitest';
import type { TaskExecution } from '@invoker/workflow-graph';
import {
  TASK_EXECUTION_RESET_RULES,
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
});

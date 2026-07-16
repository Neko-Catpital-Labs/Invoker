import { describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup } from '@invoker/data-store';
import type { MergeGateApprovalStatus } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { repairReviewGateMergeConflictByPr } from '../review-gate-merge-conflict-command.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeLookup(overrides: Partial<ReviewGateLookup> = {}): ReviewGateLookup {
  return {
    workflowId: 'wf-1',
    mergeTaskId: 'wf-1/merge',
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    branch: 'feature/conflict',
    baseBranch: 'master',
    workflowStatus: 'running',
    workflowGeneration: 2,
    mergeTaskStatus: 'review_ready',
    selectedAttemptId: 'attempt-1',
    ...overrides,
  };
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, ...(config ?? {}) },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/conflict',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          headSha: 'sha-1',
        }],
      },
      ...(execution ?? {}),
    },
    taskStateVersion: 10,
    ...rest,
  } as TaskState;
}

function makeCheckStatus(overrides: Partial<MergeGateApprovalStatus> = {}): MergeGateApprovalStatus {
  return {
    lifecycle: 'open',
    rejected: false,
    statusText: 'Merge conflict',
    url: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/conflict',
    mergeState: 'dirty',
    hasMergeConflict: true,
    ...overrides,
  };
}

describe('repairReviewGateMergeConflictByPr', () => {
  it('returns unmapped when the PR has no local workflow', async () => {
    const checkApproval = vi.fn();
    const result = await repairReviewGateMergeConflictByPr('123', {
      persistence: {
        findReviewGateByPr: () => undefined,
        loadTask: () => undefined,
      },
      repoRoot: '/repo',
      policy: {
        store: { loadTasks: () => [] },
        submitter: { submit: vi.fn(() => 42) },
        logger,
      },
      mergeGateProvider: { checkApproval },
    });

    expect(result).toMatchObject({ status: 'unmapped', reason: 'no-local-workflow', prNumber: '123' });
    expect(checkApproval).not.toHaveBeenCalled();
  });

  it('returns unmapped when the merge task is missing', async () => {
    const checkApproval = vi.fn();
    const result = await repairReviewGateMergeConflictByPr('123', {
      persistence: {
        findReviewGateByPr: () => makeLookup(),
        loadTask: () => undefined,
      },
      repoRoot: '/repo',
      policy: {
        store: { loadTasks: () => [] },
        submitter: { submit: vi.fn(() => 42) },
        logger,
      },
      mergeGateProvider: { checkApproval },
    });

    expect(result).toMatchObject({ status: 'unmapped', reason: 'merge-task-missing', prNumber: '123' });
    expect(checkApproval).not.toHaveBeenCalled();
  });

  it('queues a merge-conflict repair when the mapped PR is conflicted', async () => {
    const submit = vi.fn(() => 42);
    const checkApproval = vi.fn(async () => makeCheckStatus());
    const result = await repairReviewGateMergeConflictByPr('123', {
      persistence: {
        findReviewGateByPr: () => makeLookup(),
        loadTask: () => makeTask(),
      },
      repoRoot: '/repo',
      policy: {
        store: {
          loadTasks: () => [makeTask()],
          loadTask: () => makeTask(),
          listWorkflowMutationIntents: () => [],
          getWorkerAction: () => undefined,
        },
        submitter: { submit },
        logger,
      },
      mergeGateProvider: { checkApproval },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    expect(checkApproval).toHaveBeenCalledWith({ identifier: '123', cwd: '/repo' });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: 'queued',
      reason: 'queued',
      prNumber: '123',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    });
  });

  it('skips mapped PRs whose status is not an actionable merge conflict', async () => {
    const submit = vi.fn(() => 42);
    const result = await repairReviewGateMergeConflictByPr('123', {
      persistence: {
        findReviewGateByPr: () => makeLookup(),
        loadTask: () => makeTask(),
      },
      repoRoot: '/repo',
      policy: {
        store: {
          loadTasks: () => [makeTask()],
          loadTask: () => makeTask(),
          listWorkflowMutationIntents: () => [],
          getWorkerAction: () => undefined,
        },
        submitter: { submit },
        logger,
      },
      mergeGateProvider: {
        checkApproval: async () => makeCheckStatus({
          hasMergeConflict: false,
          statusText: 'Branch is behind base',
        }),
      },
    });

    expect(result).toMatchObject({
      status: 'skipped',
      reason: 'review status is Branch is behind base',
      prNumber: '123',
    });
    expect(result.message).toContain('Branch is behind base');
    expect(submit).not.toHaveBeenCalled();
  });
});

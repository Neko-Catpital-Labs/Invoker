import { describe, expect, it, vi } from 'vitest';

import type { ReviewGateLookup } from '@invoker/data-store';
import { createAutoFixAttemptLedger, type MergeGateApprovalStatus } from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

import { repairReviewGateCiByPr } from '../review-gate-ci-repair-command.js';

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
    branch: 'feature/ci',
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
      branch: 'feature/ci',
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
    statusText: 'Awaiting review',
    url: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/ci',
    mergeState: 'clean',
    checks: {
      state: 'failure',
      failed: [{ name: 'types', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' }],
    },
    ...overrides,
  };
}

describe('repairReviewGateCiByPr', () => {
  it('returns unmapped when the PR has no local workflow', async () => {
    const checkApproval = vi.fn();
    const result = await repairReviewGateCiByPr('123', {
      persistence: {
        findReviewGateByPr: () => undefined,
        loadTask: () => undefined,
      },
      repoRoot: '/repo',
      policy: {
        store: { loadTasks: () => [] },
        submitter: { submit: vi.fn(() => 42) },
        logger,
        attemptLedger: createAutoFixAttemptLedger(),
      },
      mergeGateProvider: { checkApproval },
    });

    expect(result).toMatchObject({ status: 'unmapped', reason: 'no-local-workflow', prNumber: '123' });
    expect(checkApproval).not.toHaveBeenCalled();
  });

  it('queues a CI repair when the mapped PR is red', async () => {
    const submit = vi.fn(() => 42);
    const checkApproval = vi.fn(async () => makeCheckStatus());
    const result = await repairReviewGateCiByPr('123', {
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
        defaultAutoFixRetries: 2,
        getAutoFixAgent: () => 'codex',
        attemptLedger: createAutoFixAttemptLedger(),
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

  it('skips mapped PRs whose checks are green', async () => {
    const submit = vi.fn(() => 42);
    const result = await repairReviewGateCiByPr('123', {
      persistence: {
        findReviewGateByPr: () => makeLookup(),
        loadTask: () => makeTask(),
      },
      repoRoot: '/repo',
      policy: {
        store: {
          loadTasks: () => [makeTask()],
          loadTask: () => makeTask(),
        },
        submitter: { submit },
        logger,
        defaultAutoFixRetries: 2,
        attemptLedger: createAutoFixAttemptLedger(),
      },
      mergeGateProvider: {
        checkApproval: async () => makeCheckStatus({
          checks: { state: 'success', failed: [] },
        }),
      },
    });

    expect(result).toMatchObject({ status: 'skipped', reason: 'checks-not-failing', prNumber: '123' });
    expect(submit).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { MergeGateApprovalStatus } from '../merge-gate-provider.js';
import {
  maybePublishReviewGateCiFailure,
  maybePublishReviewGateMergeConflict,
  type TaskRunnerReviewGateHost,
} from '../task-runner-review-gate.js';

const REVIEW_ID = 'owner/repo#77';
const REVIEW_URL = 'https://github.com/owner/repo/pull/77';

function reviewGateTask(config: TaskState['config'] | undefined): TaskState {
  return {
    id: '__merge__wf-missing-config',
    description: 'merge gate persisted without config',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-10-21T00:00:00.000Z'),
    ...(config ? { config } : {}),
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      reviewId: REVIEW_ID,
      branch: 'invoker/missing-config',
    },
    taskStateVersion: 3,
  } as unknown as TaskState;
}

function publisherHost() {
  const ciFailurePublish = vi.fn();
  const mergeConflictPublish = vi.fn();
  const host = {
    reviewGateCiFailurePublisher: { publish: ciFailurePublish },
    reviewGateCiFailureInFlight: new Set<string>(),
    reviewGateMergeConflictPublisher: { publish: mergeConflictPublish },
    reviewGateMergeConflictInFlight: new Set<string>(),
  } as unknown as TaskRunnerReviewGateHost;
  return { host, ciFailurePublish, mergeConflictPublish };
}

const CI_FAILURE_STATUS: MergeGateApprovalStatus = {
  lifecycle: 'open',
  rejected: false,
  statusText: 'CI failed',
  url: REVIEW_URL,
  headSha: 'abc123',
  checks: { state: 'failure', failed: [{ name: 'UI Vitest' }] },
};

const MERGE_CONFLICT_STATUS: MergeGateApprovalStatus = {
  lifecycle: 'open',
  rejected: false,
  statusText: 'Merge blocked by conflicts',
  url: REVIEW_URL,
  headSha: 'abc123',
  mergeState: 'dirty',
  hasMergeConflict: true,
};

describe('review-gate publishers when task.config is absent', () => {
  it('maybePublishReviewGateCiFailure skips publishing instead of throwing', async () => {
    const { host, ciFailurePublish } = publisherHost();

    await expect(
      maybePublishReviewGateCiFailure(host, reviewGateTask(undefined), CI_FAILURE_STATUS),
    ).resolves.toBeUndefined();

    expect(ciFailurePublish).not.toHaveBeenCalled();
  });

  it('maybePublishReviewGateMergeConflict skips publishing instead of throwing', async () => {
    const { host, mergeConflictPublish } = publisherHost();

    await expect(
      maybePublishReviewGateMergeConflict(host, reviewGateTask(undefined), MERGE_CONFLICT_STATUS),
    ).resolves.toBeUndefined();

    expect(mergeConflictPublish).not.toHaveBeenCalled();
  });

  it('still publishes both triggers when config carries a workflowId', async () => {
    const { host, ciFailurePublish, mergeConflictPublish } = publisherHost();
    const task = reviewGateTask({ workflowId: 'wf-1', isMergeNode: true } as TaskState['config']);

    await maybePublishReviewGateCiFailure(host, task, CI_FAILURE_STATUS);
    await maybePublishReviewGateMergeConflict(host, task, MERGE_CONFLICT_STATUS);

    expect(ciFailurePublish).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, workflowId: 'wf-1', reviewId: REVIEW_ID }),
    );
    expect(mergeConflictPublish).toHaveBeenCalledWith(
      expect.objectContaining({ taskId: task.id, workflowId: 'wf-1', reviewId: REVIEW_ID }),
    );
  });
});

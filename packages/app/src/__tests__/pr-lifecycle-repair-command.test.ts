import { describe, expect, it } from 'vitest';

import type { ReviewGateLookup } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  prepareQueueDequeueRepair,
  prepareReviewCommentRepair,
} from '../pr-lifecycle-repair-command.js';

const workflowId = 'wf-1';
const intent = {
  repo: 'owner/repo',
  prNumber: 123,
  headSha: 'sha-1',
  leaseId: 'lease-1',
  workflowId,
  eventKey: 'event-1',
};

function makeTask(): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId, isMergeNode: true },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/repair',
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
    },
    taskStateVersion: 3,
  } as TaskState;
}

function makeLookup(): ReviewGateLookup {
  return {
    workflowId,
    mergeTaskId: 'wf-1/merge',
    reviewId: '123',
    workflowStatus: 'running',
    workflowGeneration: 2,
    selectedAttemptId: 'attempt-1',
  };
}

function makeDeps() {
  return {
    persistence: {
      getPrMirror: () => ({
        repo: intent.repo,
        prNumber: intent.prNumber,
        headSha: intent.headSha,
        workflowId,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      getPrRepairLease: () => ({
        repo: intent.repo,
        prNumber: intent.prNumber,
        headSha: intent.headSha,
        leaseId: intent.leaseId,
        holderKind: 'review_comments' as const,
        workflowId,
        acquiredAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-02T00:00:00.000Z',
      }),
      findReviewGateByPr: () => makeLookup(),
      loadTask: () => makeTask(),
      loadWorkflow: () => ({ id: workflowId }),
    },
    now: () => new Date('2026-01-01T12:00:00.000Z'),
  };
}

describe('PR lifecycle repair commands', () => {
  it('routes review comments to the managed merge-task fix flow', () => {
    const command = prepareReviewCommentRepair({
      ...intent,
      holderKind: 'review_comments',
      commentUrl: 'https://github.com/owner/repo/pull/123#discussion_r1',
    }, makeDeps() as never);

    expect(command.workflowId).toBe(workflowId);
    expect(command.headlessArgs.slice(0, 2)).toEqual(['fix', 'wf-1/merge']);
    expect(command.headlessArgs).toContain('--review-gate-ci');
  });

  it('routes a queue dequeue to the managed merge-task fix flow', () => {
    const deps = makeDeps();
    deps.persistence.getPrRepairLease = () => ({
      repo: intent.repo,
      prNumber: intent.prNumber,
      headSha: intent.headSha,
      leaseId: intent.leaseId,
      holderKind: 'queue_dequeued',
      workflowId,
      acquiredAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
    });

    const command = prepareQueueDequeueRepair({
      ...intent,
      holderKind: 'queue_dequeued',
      failedChecks: ['quality / TypeScript Types'],
    }, deps as never);

    expect(command.workflowId).toBe(workflowId);
    expect(command.headlessArgs.slice(0, 2)).toEqual(['fix', 'wf-1/merge']);
    expect(command.headlessArgs).toContain('--review-gate-ci');
  });

  it('rejects stale or replaced repair leases before dispatch', () => {
    const deps = makeDeps();
    deps.persistence.getPrRepairLease = () => ({
      repo: intent.repo,
      prNumber: intent.prNumber,
      headSha: intent.headSha,
      leaseId: 'replacement-lease',
      holderKind: 'review_comments',
      workflowId,
      acquiredAt: '2026-01-01T00:00:00.000Z',
    });

    expect(() => prepareReviewCommentRepair({
      ...intent,
      holderKind: 'review_comments',
    }, deps as never)).toThrow(/lease is no longer held/);
  });
});

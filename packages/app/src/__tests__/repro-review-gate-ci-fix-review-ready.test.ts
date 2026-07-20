import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';

import { runReviewGateCiRepairCommand } from '../review-gate-ci-repair-command.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return logger; }),
};

function makeReviewReadyTask(): TaskState {
  return {
    id: 'wf-review/merge',
    description: 'Review gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { workflowId: 'wf-review', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 4,
      selectedAttemptId: 'attempt-review',
      reviewId: 'owner/repo#456',
      reviewGate: {
        activeGeneration: 4,
        artifacts: [{
          id: 'pr-456',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 4,
          url: 'https://github.com/owner/repo/pull/456',
          headSha: 'sha-review',
          headRef: 'feature/review-ready',
          branch: 'feature/review-ready',
          checksState: 'failure',
          failedChecks: [{ name: 'integration', conclusion: 'FAILURE' }],
          rawStatus: 'CI failed',
        }],
      },
    },
    taskStateVersion: 11,
  } as TaskState;
}

describe('repro review-gate CI fix for review_ready', () => {
  it('queues CI repair for a review_ready merge task using task review id lineage', async () => {
    const task = makeReviewReadyTask();
    const actions = new Map<string, any>();
    const submit = vi.fn(() => 456);
    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-review' } as any]),
      loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-review' ? [task] : []),
      loadTask: vi.fn((taskId: string) => taskId === task.id ? task : undefined),
      listWorkflowMutationIntents: vi.fn(() => []),
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: any) => {
        const key = `${write.workerKind}:${write.externalKey}`;
        const existing = actions.get(key);
        const saved = {
          ...write,
          id: existing?.id ?? write.id,
          attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
          createdAt: existing?.createdAt ?? '2026-01-01T00:00:00Z',
          updatedAt: write.updatedAt ?? '2026-01-01T00:00:00Z',
        };
        actions.set(key, saved);
        return saved;
      }),
      logEvent: vi.fn(),
    };

    const result = await runReviewGateCiRepairCommand({
      store,
      submitter: { submit },
      logger,
      defaultAutoFixRetries: 1,
    }, '456');

    expect(result).toMatchObject({
      decision: 'queued',
      workflowId: 'wf-review',
      taskId: 'wf-review/merge',
      reviewId: 'owner/repo#456',
      reviewUrl: 'https://github.com/owner/repo/pull/456',
      headSha: 'sha-review',
      intentId: 456,
    });
    expect(submit).toHaveBeenCalledWith(
      'wf-review',
      'normal',
      'invoker:fix-with-agent',
      expect.arrayContaining(['wf-review/merge']),
    );
  });
});

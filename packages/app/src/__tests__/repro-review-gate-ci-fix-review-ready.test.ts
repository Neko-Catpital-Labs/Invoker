import { describe, expect, it, vi } from 'vitest';
import type { WorkflowMutationIntent, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { createAutoFixAttemptLedger, type WorkerActionRecord, type WorkerActionWrite } from '@invoker/execution-engine';

import { repairReviewGateCiForTarget } from '../review-gate-ci-repair-command.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(() => logger),
};

function makeReviewReadyMergeTask(artifactOverrides: Record<string, unknown> = {}): TaskState {
  return {
    id: 'wf-review/merge',
    description: 'Merge gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-review', isMergeNode: true },
    execution: {
      generation: 3,
      selectedAttemptId: 'attempt-review',
      branch: 'feature/review-ready-ci',
      reviewGate: {
        activeGeneration: 3,
        artifacts: [{
          id: 'pr-321',
          providerId: '321',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 3,
          url: 'https://github.com/owner/repo/pull/321',
          headSha: 'sha-review',
          checksState: 'failure',
          failedChecks: [{ name: 'unit', conclusion: 'FAILURE' }],
          rawStatus: 'CI failed',
          ...artifactOverrides,
        }],
      },
    },
    taskStateVersion: 11,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeDeps(task: TaskState) {
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => {
    expect(workflowId).toBe('wf-review');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:fix-with-agent');
    expect(args[0]).toBe('wf-review/merge');
    return 7;
  });
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-review' }]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-review' ? [task] : []),
    loadTask: vi.fn((taskId: string) => taskId === task.id ? task : undefined),
    listWorkflowMutationIntents: vi.fn((): WorkflowMutationIntent[] => []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return {
    submit,
    deps: {
      store,
      submitter: { submit },
      logger,
      defaultAutoFixRetries: 2,
      attemptLedger: createAutoFixAttemptLedger(),
      now: () => '2026-01-01T00:00:00.000Z',
    },
  };
}

describe('repro: review-gate CI repair for review_ready gates', () => {
  it('queues a CI repair for a workflow-mapped review_ready PR with failed checks', async () => {
    const { deps, submit } = makeDeps(makeReviewReadyMergeTask());

    const result = await repairReviewGateCiForTarget('321', deps);

    expect(result).toMatchObject({
      decision: 'queued',
      reason: 'queued',
      intentId: 7,
      mapping: {
        workflowId: 'wf-review',
        taskId: 'wf-review/merge',
        status: 'review_ready',
      },
    });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('does not introduce merge-conflict behavior into the CI repair command path', async () => {
    const { deps, submit } = makeDeps(makeReviewReadyMergeTask({
      mergeState: 'dirty',
      rawStatus: 'Merge conflict',
    }));

    const result = await repairReviewGateCiForTarget('321', deps);

    expect(result).toMatchObject({
      decision: 'skipped',
      reason: 'merge-conflict',
      mapping: {
        workflowId: 'wf-review',
        taskId: 'wf-review/merge',
        mergeState: 'dirty',
      },
    });
    expect(submit).not.toHaveBeenCalled();
  });
});

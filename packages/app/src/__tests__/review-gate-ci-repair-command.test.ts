import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationPriority } from '@invoker/data-store';

import {
  queryReviewGateCiRepairTarget,
  resolveReviewGateWorkflowIdForPrTarget,
  runReviewGateCiRepairCommand,
} from '../review-gate-ci-repair-command.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(function () { return logger; }),
};

function makeMergeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/merge',
    description: 'Review gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00Z'),
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      reviewGate: {
        activeGeneration: 2,
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          url: 'https://github.com/owner/repo/pull/123',
          headSha: 'sha-1',
          headRef: 'feature/ci',
          branch: 'feature/ci',
          checksState: 'failure',
          failedChecks: [
            { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
          ],
          rawStatus: 'CI failed',
        }],
      },
    },
    taskStateVersion: 7,
    ...overrides,
  } as TaskState;
}

function makeHarness(task: TaskState = makeMergeTask()) {
  const actions = new Map<string, any>();
  const submit = vi.fn((
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => {
    expect(workflowId).toBe('wf-1');
    expect(priority).toBe('normal');
    expect(channel).toBe('invoker:fix-with-agent');
    expect(args[0]).toBe('wf-1/merge');
    return 42;
  });
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' } as any]),
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-1' ? [task] : []),
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
  return { actions, store, submit };
}

describe('review-gate-ci-repair-command', () => {
  it('queues CI repair for a workflow-mapped failed review gate PR', async () => {
    const harness = makeHarness();

    const result = await runReviewGateCiRepairCommand({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
      getAutoFixAgent: () => 'codex',
    }, 'https://github.com/owner/repo/pull/123');

    expect(result).toMatchObject({
      ok: true,
      decision: 'queued',
      reason: 'queued',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      intentId: 42,
    });
    expect(harness.submit).toHaveBeenCalledTimes(1);
  });

  it('skips a mapped PR when the current review gate has no failed CI checks', async () => {
    const task = makeMergeTask({
      execution: {
        ...makeMergeTask().execution,
        reviewGate: {
          activeGeneration: 2,
          artifacts: [{
            id: 'pr-123',
            providerId: '123',
            required: true,
            status: 'open',
            generation: 2,
            url: 'https://github.com/owner/repo/pull/123',
            checksState: 'success',
            failedChecks: [],
          }],
        },
      } as any,
    });
    const harness = makeHarness(task);

    const result = await runReviewGateCiRepairCommand({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, '123');

    expect(result).toMatchObject({
      ok: true,
      decision: 'skipped',
      reason: 'no-current-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('returns unmapped when no workflow review gate references the PR', async () => {
    const harness = makeHarness();

    const result = await runReviewGateCiRepairCommand({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, '999');

    expect(result).toEqual({
      ok: true,
      decision: 'unmapped',
      reason: 'no-workflow-mapped-review-gate',
      target: { input: '999', prNumber: '999', reviewId: '999' },
    });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('exposes workflow mapping for query and mutation classification', () => {
    const harness = makeHarness();

    expect(resolveReviewGateWorkflowIdForPrTarget(harness.store, '123')).toBe('wf-1');
    expect(queryReviewGateCiRepairTarget({ store: harness.store, logger }, '123')).toMatchObject({
      decision: 'queued',
      reason: 'current-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/merge',
    });
  });
});

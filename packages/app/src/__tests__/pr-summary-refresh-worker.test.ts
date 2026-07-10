import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
  type MergeGateProvider,
} from '@invoker/execution-engine';

const now = new Date('2026-01-01T00:00:00.000Z');

function task(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Task one',
    status: 'completed',
    dependencies: [],
    createdAt: now,
    taskStateVersion: 1,
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    ...overrides,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const updatedAt = write.updatedAt ?? '2026-01-01T00:10:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? updatedAt,
    updatedAt,
  } as WorkerActionRecord;
}

function harness(currentBody = 'old body') {
  const mergeTask = task({
    id: '__merge__wf-1',
    description: 'Merge workflow',
    status: 'review_ready',
    config: {
      workflowId: 'wf-1',
      runnerKind: 'merge',
      isMergeNode: true,
      summary: 'Workflow summary',
    },
    execution: {
      workspacePath: '/tmp/repo',
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'artifact-1',
          provider: 'github',
          providerId: '42',
          url: 'https://github.com/owner/repo/pull/42',
          required: true,
          status: 'open',
          generation: 0,
        }],
      },
    },
  });
  const buildTask = task({});
  const actions = new Map<string, WorkerActionRecord>();
  actions.set('ci-failure:seed', {
    id: 'seed',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'seed',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed failing checks',
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
    completedAt: '2026-01-01T00:02:00.000Z',
  });

  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadTasks: vi.fn(() => [buildTask, mergeTask]),
    listWorkerActions: vi.fn(({ workflowId }: { workflowId?: string } = {}) =>
      [...actions.values()].filter((action) => !workflowId || action.workflowId === workflowId)),
    getWorkerAction: vi.fn((kind: string, key: string) => actions.get(`${kind}:${key}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => currentBody),
    updateReviewBody: vi.fn(async () => undefined),
  };
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
  return { store, provider, logger };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical worker pipeline content', async () => {
    const h = harness();

    await refreshPrSummaries({ store: h.store, provider: h.provider, logger: h.logger });

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = vi.mocked(h.provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body).toContain('ci-failure');
    expect(body).toContain('Fixed failing checks');
    expect(h.store.upsertWorkerAction.mock.calls.map((call) => call[0].status)).toEqual(['running', 'completed']);
    expect(h.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
        reviewId: '42',
      }),
    );
  });

  it('skips provider updates when the canonical body is already current', async () => {
    const h = harness();

    await refreshPrSummaries({ store: h.store, provider: h.provider, logger: h.logger });
    const body = vi.mocked(h.provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    vi.mocked(h.provider.getReviewBody).mockResolvedValue(body);

    await refreshPrSummaries({ store: h.store, provider: h.provider, logger: h.logger });

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(h.store.upsertWorkerAction.mock.calls.at(-1)?.[0]).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      summary: 'PR summary already current',
    });
  });

  it('records failed update state without double-counting the running attempt', async () => {
    const h = harness();
    vi.mocked(h.provider.updateReviewBody).mockRejectedValueOnce(new Error('patch failed'));

    await refreshPrSummaries({ store: h.store, provider: h.provider, logger: h.logger });

    expect(h.store.upsertWorkerAction.mock.calls.map((call) => call[0].status)).toEqual(['running', 'failed']);
    expect(h.store.upsertWorkerAction.mock.calls.map((call) => call[0].attemptCount)).toEqual([1, 1]);
    expect(h.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'failed',
        reviewId: '42',
      }),
    );
  });
});

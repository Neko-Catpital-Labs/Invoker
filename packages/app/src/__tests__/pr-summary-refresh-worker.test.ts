import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  buildPrSummaryAuthoringContext,
  refreshPrSummaries,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Build feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test', ...(config ?? {}) },
    execution: { generation: 1, ...(execution ?? {}) },
    taskStateVersion: 1,
    ...rest,
  };
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge', summary: 'Ready for review' } as TaskState['config'],
    execution: {
      generation: 1,
      workspacePath: '/tmp/worktree',
      reviewUrl: 'https://github.com/owner/repo/pull/42',
      reviewId: '42',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '42',
          title: 'Workflow A',
          url: 'https://github.com/owner/repo/pull/42',
          providerId: '42',
          provider: 'github',
          branch: 'feature/wf-1',
          baseBranch: 'main',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
  });
}

function makeStore(): PrSummaryRefreshWorkerStore & {
  actions: Map<string, WorkerActionRecord>;
  upsertWorkerAction: ReturnType<typeof vi.fn>;
  logEvent: ReturnType<typeof vi.fn>;
} {
  const actions = new Map<string, WorkerActionRecord>();
  actions.set('autofix:wf-1/task-1', {
    id: 'autofix:wf-1/task-1',
    workerKind: 'autofix',
    actionType: 'auto-fix',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1:g1',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed failing tests',
    payload: {},
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  });

  const store = {
    actions,
    listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow A', description: 'Ship worker visibility.' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Workflow A',
      description: 'Ship worker visibility.',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    })),
    loadTasks: vi.fn(() => [makeTask(), makeMergeTask()]),
    listWorkerActions: vi.fn(() => [...actions.values()].sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const now = write.updatedAt ?? '2026-01-01T00:02:00.000Z';
      const saved: WorkerActionRecord = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: now,
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return store;
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('pr-summary-refresh worker', () => {
  it('renders canonical PR bodies with worker actions and updates only on content changes', async () => {
    const store = makeStore();
    const provider = {
      name: 'github',
      createReview: vi.fn(),
      checkApproval: vi.fn(),
      getReviewBody: vi.fn().mockResolvedValueOnce('old body'),
      updateReviewBody: vi.fn().mockResolvedValue(undefined),
    };

    await refreshPrSummaries({ store, logger, provider, cwd: '/repo' });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = provider.updateReviewBody.mock.calls[0]?.[0].body as string;
    expect(body).toContain('## Pipeline');
    expect(body).toContain('| 2026-01-01T00:01:00.000Z | autofix | auto-fix | wf-1/task-1 | completed | Fixed failing tests |');
    expect(body).not.toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'pr-summary-refresh',
      status: 'completed',
      taskId: '__merge__wf-1',
      subjectType: 'pull_request',
      subjectId: '42',
    }));
    expect(store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
        summary: 'Refreshed PR Pipeline summary for 42',
      }),
    );

    provider.getReviewBody.mockResolvedValueOnce(body);
    await refreshPrSummaries({ store, logger, provider, cwd: '/repo' });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(store.upsertWorkerAction).toHaveBeenLastCalledWith(expect.objectContaining({
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'content-unchanged' }),
    }));
  });

  it('builds authoring context without feeding summary-refresh self actions back into Pipeline', () => {
    const store = makeStore();
    store.actions.set(`${PR_SUMMARY_REFRESH_WORKER_KIND}:wf-1:42:g1`, {
      id: `${PR_SUMMARY_REFRESH_WORKER_KIND}:wf-1:42:g1`,
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'pr-summary-refresh',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'pull_request',
      subjectId: '42',
      externalKey: 'wf-1:42:g1',
      status: 'completed',
      attemptCount: 1,
      summary: 'Refreshed body',
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
      completedAt: '2026-01-01T00:02:00.000Z',
    });

    const ctx = buildPrSummaryAuthoringContext(store, 'wf-1');

    expect(ctx.workerActions?.map((action) => action.workerKind)).toEqual(['autofix']);
  });
});

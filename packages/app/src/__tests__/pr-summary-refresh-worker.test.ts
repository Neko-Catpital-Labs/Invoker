import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { MergeGateProvider } from '@invoker/execution-engine';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPublishedPrSummaries,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Build feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'pnpm test',
      ...(config ?? {}),
    },
    execution: {
      generation: 1,
      ...(execution ?? {}),
    },
    taskStateVersion: 1,
    ...rest,
  };
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge workflow',
    status: 'review_ready',
    config: {
      workflowId: 'wf-1',
      isMergeNode: true,
      runnerKind: 'merge',
      summary: 'Published review branch.',
    } as never,
    execution: {
      generation: 2,
      workspacePath: '/tmp/review-workspace',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '123',
          title: 'PR Pipeline',
          url: 'https://github.test/owner/repo/pull/123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      },
    },
  });
}

function makeHarness() {
  const actions = new Map<string, WorkerActionRecord>();
  actions.set('autofix:wf-1/task-1:g1', {
    id: 'autofix:wf-1/task-1:g1',
    workerKind: 'autofix',
    actionType: 'auto-fix',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1:g1',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed failing unit test',
    payload: {},
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  });
  const mergeTask = makeMergeTask();
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Pipeline workflow', description: 'Expose worker actions.' }]),
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Pipeline workflow', description: 'Expose worker actions.' })),
    loadTasks: vi.fn(() => [makeTask(), mergeTask]),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const now = write.updatedAt ?? '2026-01-01T00:00:05.000Z';
      const saved: WorkerActionRecord = {
        ...write,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: now,
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  const provider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => 'old body'),
    updateReviewBody: vi.fn(async () => undefined),
  } as unknown as MergeGateProvider;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };
  return { actions, store, provider, logger };
}

describe('pr-summary-refresh worker', () => {
  it('renders canonical PR body with worker actions and records update state', async () => {
    const h = makeHarness();

    await refreshPublishedPrSummaries({
      logger: h.logger,
      store: h.store,
      provider: h.provider,
      cwd: '/repo',
    });

    expect(h.provider.getReviewBody).toHaveBeenCalledWith({ identifier: '123', cwd: '/tmp/review-workspace' });
    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = vi.mocked(h.provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body).toContain('autofix');
    expect(body).toContain('Fixed failing unit test');

    const refreshAction = [...h.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'completed',
      attemptCount: 1,
      summary: 'Updated PR pipeline summary',
      subjectType: 'pull_request',
      subjectId: '123',
    });
    expect(h.store.logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      message: 'Updated PR pipeline summary',
      reviewId: '123',
    }));
  });

  it('does not update the provider when the rendered body is already current', async () => {
    const h = makeHarness();

    await refreshPublishedPrSummaries({
      logger: h.logger,
      store: h.store,
      provider: h.provider,
      cwd: '/repo',
    });
    const body = vi.mocked(h.provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    vi.mocked(h.provider.getReviewBody).mockResolvedValue(body);

    await refreshPublishedPrSummaries({
      logger: h.logger,
      store: h.store,
      provider: h.provider,
      cwd: '/repo',
    });

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const refreshAction = [...h.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'skipped',
      attemptCount: 1,
      summary: 'PR summary already current',
      payload: expect.objectContaining({ reason: 'body-unchanged' }),
    });
  });
});

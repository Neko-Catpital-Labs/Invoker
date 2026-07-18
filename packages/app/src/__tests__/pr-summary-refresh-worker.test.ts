import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildPrSummaryBody,
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type PrSummaryRefreshCandidate,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';

const TICK_CONTEXT = {
  identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
  reason: 'manual' as const,
  tickNumber: 1,
  signal: new AbortController().signal,
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/build',
    description: 'Build project',
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
    id: 'wf-1/__merge__',
    description: 'Merge gate',
    status: 'review_ready',
    config: {
      workflowId: 'wf-1',
      isMergeNode: true,
      runnerKind: 'merge',
      summary: 'Merged workflow work.',
    },
    execution: {
      generation: 2,
      workspacePath: '/repo',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'review-123',
          providerId: '123',
          provider: 'github',
          url: 'https://github.com/acme/repo/pull/123',
          required: true,
          status: 'open',
          generation: 2,
        }],
      },
    },
  });
}

function makeAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'ci-failure:key',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/build',
    subjectType: 'review',
    subjectId: '123',
    externalKey: 'ci-failure:key',
    status: 'completed',
    attemptCount: 1,
    summary: 'Submitted CI repair.',
    payload: {},
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function makeStore(tasks: TaskState[], actions: WorkerActionRecord[] = []): {
  store: PrSummaryRefreshWorkerStore;
  savedActions: Map<string, WorkerActionRecord>;
} {
  const savedActions = new Map(actions.map((action) => [`${action.workerKind}:${action.externalKey}`, action]));
  const store: PrSummaryRefreshWorkerStore = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Worker summary workflow',
      description: 'Reviewers can see what Invoker did.',
    })),
    loadTasks: vi.fn(() => tasks),
    listWorkerActions: vi.fn((filters = {}) => [...savedActions.values()]
      .filter((action) => !filters.workflowId || action.workflowId === filters.workflowId)
      .filter((action) => !filters.workerKind || action.workerKind === filters.workerKind)
      .slice(0, filters.limit ?? undefined)),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      savedActions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = savedActions.get(key);
      const saved: WorkerActionRecord = {
        id: write.id,
        workerKind: write.workerKind,
        actionType: write.actionType,
        workflowId: write.workflowId,
        taskId: write.taskId,
        subjectType: write.subjectType,
        subjectId: write.subjectId,
        externalKey: write.externalKey,
        status: write.status,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        summary: write.summary,
        payload: write.payload,
        createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:02:00.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:02:00.000Z',
        completedAt: write.completedAt,
      };
      savedActions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { store, savedActions };
}

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical pipeline rows and records action state', async () => {
    const mergeTask = makeMergeTask();
    const { store, savedActions } = makeStore([makeTask(), mergeTask], [makeAction()]);
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => 'old body'),
      updateReviewBody: vi.fn(async () => undefined),
    };

    await createPrSummaryRefreshTick({
      logger,
      store,
      provider,
    })(TICK_CONTEXT);

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = provider.updateReviewBody.mock.calls[0]?.[0]?.body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body).toContain('| 2026-01-01T00:01:00.000Z | ci-failure | fix-ci-failure | completed | wf-1/build | Submitted CI repair. |');
    expect(body).toContain('- [x] `pnpm test` — Build project');

    const refreshAction = [...savedActions.values()].find((action) =>
      action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'completed',
      taskId: 'wf-1/__merge__',
      summary: 'Updated PR body with Invoker pipeline summary',
    });
    expect(store.logEvent).toHaveBeenCalledWith(
      'wf-1/__merge__',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
        status: 'completed',
      }),
    );
  });

  it('skips provider updates when the live body already matches', async () => {
    const mergeTask = makeMergeTask();
    const { store, savedActions } = makeStore([makeTask(), mergeTask], [makeAction()]);
    const candidate: PrSummaryRefreshCandidate = {
      workflowId: 'wf-1',
      mergeTask,
      artifact: mergeTask.execution.reviewGate!.artifacts[0]!,
    };
    const currentBody = buildPrSummaryBody(candidate, store);
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => `${currentBody}\n`),
      updateReviewBody: vi.fn(async () => undefined),
    };

    const tick = createPrSummaryRefreshTick({
      logger,
      store,
      provider,
    });

    await tick(TICK_CONTEXT);

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    const refreshAction = [...savedActions.values()].find((action) =>
      action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'skipped',
      summary: 'PR body already includes current Invoker pipeline summary',
    });
    expect(refreshAction?.payload).toMatchObject({ reason: 'body-current' });
    expect(store.logEvent).toHaveBeenCalledTimes(1);

    await tick({ ...TICK_CONTEXT, tickNumber: 2 });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    expect(store.logEvent).toHaveBeenCalledTimes(1);
  });
});

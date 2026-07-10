import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildCanonicalPrBody,
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Run tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    ...overrides,
  } as TaskState;
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 2,
      workspacePath: '/tmp/repo',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-42',
          title: 'Visibility PR',
          url: 'https://github.com/owner/repo/pull/42',
          providerId: '42',
          provider: 'github',
          branch: 'feature/visibility',
          baseBranch: 'main',
          required: true,
          status: 'open',
          generation: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      },
    },
  });
}

function makeWorkerAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'ci-failure:key',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'ci-key',
    status: 'completed',
    attemptCount: 1,
    summary: 'Queued CI repair',
    payload: { reason: 'ci-failed' },
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function makeStore(tasks: TaskState[], seedActions: WorkerActionRecord[] = []) {
  const actions = new Map(seedActions.map((action) => [`${action.workerKind}:${action.externalKey}`, action]));
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store: PrSummaryRefreshWorkerStore = {
    listWorkflows: () => [{ id: 'wf-1' }],
    loadWorkflow: () => ({ id: 'wf-1', name: 'Visibility workflow', description: 'Implement visibility.' }),
    loadTasks: () => tasks,
    getWorkerAction: (workerKind, externalKey) => actions.get(`${workerKind}:${externalKey}`),
    upsertWorkerAction: (write: WorkerActionWrite) => {
      const now = write.updatedAt ?? '2026-01-01T00:05:00.000Z';
      const record: WorkerActionRecord = {
        id: write.id,
        workerKind: write.workerKind,
        actionType: write.actionType,
        ...(write.workflowId ? { workflowId: write.workflowId } : {}),
        ...(write.taskId ? { taskId: write.taskId } : {}),
        subjectType: write.subjectType,
        subjectId: write.subjectId,
        externalKey: write.externalKey,
        status: write.status,
        attemptCount: write.attemptCount ?? 0,
        ...(write.summary ? { summary: write.summary } : {}),
        payload: write.payload,
        createdAt: write.createdAt ?? now,
        updatedAt: now,
        ...(write.completedAt ? { completedAt: write.completedAt } : {}),
      };
      actions.set(`${record.workerKind}:${record.externalKey}`, record);
      return record;
    },
    listWorkerActions: (filters) => [...actions.values()].filter((action) => (
      !filters?.workflowId || action.workflowId === filters.workflowId
    )),
    logEvent: (taskId, eventType, payload) => {
      events.push({ taskId, eventType, payload });
    },
  };
  return { store, actions, events };
}

describe('pr-summary-refresh worker', () => {
  it('updates the PR body only when the rendered canonical body changes and records action state', async () => {
    const mergeTask = makeMergeTask();
    const task = makeTask({});
    const seedAction = makeWorkerAction();
    const harness = makeStore([task, mergeTask], [seedAction]);
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => 'old body'),
      updateReviewBody: vi.fn(async () => {}),
    };

    await createPrSummaryRefreshTick({
      store: harness.store,
      mergeGateProvider: provider,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    })();

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = provider.updateReviewBody.mock.calls[0]?.[0]?.body;
    expect(body).toContain('## Pipeline');
    expect(body).toContain('ci-failure');
    expect(body).toContain('Queued CI repair');

    const refreshAction = [...harness.actions.values()].find((action) =>
      action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'completed',
      summary: 'Refreshed PR summary body',
      taskId: '__merge__wf-1',
      subjectId: '42',
    });
    expect(harness.events).toContainEqual(expect.objectContaining({
      taskId: '__merge__wf-1',
      eventType: 'task.worker_action',
      payload: expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
        reviewId: '42',
      }),
    }));
  });

  it('skips provider update when the live body already matches', async () => {
    const mergeTask = makeMergeTask();
    const task = makeTask({});
    const seedAction = makeWorkerAction();
    const harness = makeStore([task, mergeTask], [seedAction]);
    const expectedBody = buildCanonicalPrBody({
      title: 'Visibility PR',
      workflowSummary: 'Implement visibility.',
      structuredContext: {
        workflowName: 'Visibility workflow',
        workflowDescription: 'Implement visibility.',
        tasks: [{ taskId: 'wf-1/task-1', description: 'Run tests', status: 'completed', command: 'pnpm test' }],
        workerActions: [{
          workerKind: 'ci-failure',
          actionType: 'fix-ci-failure',
          status: 'completed',
          taskId: 'wf-1/task-1',
          subjectType: 'review',
          subjectId: '42',
          summary: 'Queued CI repair',
          reason: 'ci-failed',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
          completedAt: '2026-01-01T00:01:00.000Z',
        }],
      },
    });
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => `${expectedBody}\n`),
      updateReviewBody: vi.fn(async () => {}),
    };

    await createPrSummaryRefreshTick({
      store: harness.store,
      mergeGateProvider: provider,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    })();

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    const refreshAction = [...harness.actions.values()].find((action) =>
      action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'skipped',
      summary: 'PR summary already up to date',
    });
  });
});

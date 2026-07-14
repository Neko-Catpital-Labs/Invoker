import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type MergeGateProvider,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Implement feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test', ...(config ?? {}) },
    execution: { generation: 0, ...(execution ?? {}) },
    taskStateVersion: 1,
    ...rest,
  };
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge workflow',
    status: 'review_ready',
    config: { workflowId: 'wf-1', runnerKind: 'merge', isMergeNode: true },
    execution: {
      generation: 0,
      reviewUrl: 'https://github.com/owner/repo/pull/42',
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '42',
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
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = write.updatedAt ?? '2026-01-01T00:00:10.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: now,
  };
}

function makeStore() {
  const actions = new Map<string, WorkerActionRecord>();
  const logEvent = vi.fn();
  const store = {
    listWorkflows: vi.fn(() => [{
      id: 'wf-1',
      name: 'Worker visibility',
      description: 'Show what Invoker did.',
      reviewProvider: 'github',
    }]),
    loadTasks: vi.fn(() => [
      makeTask(),
      makeMergeTask(),
    ]),
    listWorkerActions: vi.fn((filters?: { workflowId?: string }) => [...actions.values()]
      .filter((action) => !filters?.workflowId || action.workflowId === filters.workflowId)),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    logEvent,
    actions,
  };

  store.upsertWorkerAction({
    id: 'autofix:wf-1/task-1',
    workerKind: 'autofix',
    actionType: 'auto-retry',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'wf-1/task-1',
    status: 'completed',
    attemptCount: 1,
    summary: 'Retried failed task',
    payload: { reason: 'transient-failure' },
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
    completedAt: '2026-01-01T00:00:01.000Z',
  });

  return store;
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies, skips unchanged bodies, and records action state', async () => {
    const store = makeStore();
    let remoteBody = 'old body';
    const provider: MergeGateProvider = {
      name: 'github',
      createReview: vi.fn(),
      checkApproval: vi.fn(),
      getReviewBody: vi.fn(async () => remoteBody),
      updateReviewBody: vi.fn(async ({ body }) => {
        remoteBody = body;
      }),
    };
    const tick = createPrSummaryRefreshTick({
      store,
      mergeGateProvider: provider,
      cwd: '/tmp/repo',
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    });
    const signal = new AbortController().signal;

    await tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal,
    });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(remoteBody).toContain('## Pipeline');
    expect(remoteBody).toContain('| 2026-01-01T00:00:01.000Z | autofix | auto-retry | completed | task wf-1/task-1 | Retried failed task (transient-failure) |');
    expect(store.logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      summary: 'Updated PR summary with current Invoker pipeline',
    }));

    await tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 2,
      signal,
    });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const refreshAction = [...store.actions.values()]
      .find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      status: 'skipped',
      summary: 'PR summary already up to date',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
    });
    expect(store.logEvent).toHaveBeenLastCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      reason: 'unchanged',
    }));
  });
});

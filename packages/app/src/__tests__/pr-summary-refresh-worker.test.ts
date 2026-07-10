import { describe, expect, it, vi } from 'vitest';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
} from '@invoker/execution-engine';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Implement worker visibility',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test', ...(config ?? {}) },
    execution: execution ?? {},
    taskStateVersion: 1,
    ...rest,
  };
}

function makeStore() {
  const workflow: Workflow = {
    id: 'wf-1',
    name: 'Worker Visibility',
    description: 'Show what Invoker workers did.',
    status: 'running',
    onFinish: 'pull_request',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const mergeTask = makeTask({
    id: '__merge__wf-1',
    description: 'Merge',
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      reviewId: '42',
      reviewUrl: 'https://github.com/owner/repo/pull/42',
      workspacePath: '/repo',
    },
  });
  const workTask = makeTask();
  const actions = new Map<string, WorkerActionRecord>();
  const existingAction: WorkerActionRecord = {
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
    payload: {},
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  };
  actions.set(`${existingAction.workerKind}:${existingAction.externalKey}`, existingAction);

  const store = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn(() => workflow),
    loadTasks: vi.fn(() => [workTask, mergeTask]),
    listWorkerActions: vi.fn((filters?: { workflowId?: string }) =>
      [...actions.values()].filter((action) => !filters?.workflowId || action.workflowId === filters.workflowId)),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const now = '2026-01-01T00:02:00.000Z';
      const saved: WorkerActionRecord = {
        ...write,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: write.updatedAt ?? now,
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { store, actions };
}

describe('pr-summary-refresh worker', () => {
  it('refreshes changed PR bodies with worker actions and skips identical bodies', async () => {
    const { store, actions } = makeStore();
    let currentBody = 'old body';
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => currentBody),
      updateReviewBody: vi.fn(async ({ body }: { body: string }) => {
        currentBody = body;
      }),
    };

    await refreshPrSummaries({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
      store,
      mergeGateProvider: provider,
    });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const updatedBody = provider.updateReviewBody.mock.calls[0]?.[0].body;
    expect(updatedBody).toContain('## Pipeline');
    expect(updatedBody).toContain('| 2026-01-01T00:01:00.000Z | autofix | auto-retry | wf-1/task-1 | completed | Retried failed task |');
    expect(store.logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      reviewId: '42',
    }));

    provider.updateReviewBody.mockClear();
    store.logEvent.mockClear();
    await refreshPrSummaries({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() },
      store,
      mergeGateProvider: provider,
    });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    expect(store.logEvent).not.toHaveBeenCalled();
    expect(actions.get(`${PR_SUMMARY_REFRESH_WORKER_KIND}:__merge__wf-1:42`)).toMatchObject({
      status: 'skipped',
      summary: 'PR summary already current',
    });
  });
});

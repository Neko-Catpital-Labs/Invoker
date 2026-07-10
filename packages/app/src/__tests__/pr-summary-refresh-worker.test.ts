import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
} from '@invoker/execution-engine';

function task(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'wf-1/task',
    description: 'Task',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function makeStore() {
  const actions = new Map<string, WorkerActionRecord>();
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  actions.set('ci-failure:ci-failure:wf-1/build:42', {
    id: 'ci-action',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/build',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'ci-failure:wf-1/build:42',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed failed CI',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
  });

  const mergeTask = task({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, summary: 'Merge summary' },
    execution: {
      workspacePath: '/tmp/worktree',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '42',
          providerId: '42',
          provider: 'github',
          url: 'https://github.com/owner/repo/pull/42',
          required: true,
          status: 'open',
          generation: 2,
        }],
      },
    },
  });
  const buildTask = task({
    id: 'wf-1/build',
    description: 'Build feature',
    config: { workflowId: 'wf-1', command: 'pnpm test' },
  });

  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Pipeline visibility',
      description: 'Show Invoker pipeline actions.',
    })),
    loadTasks: vi.fn(() => [buildTask, mergeTask]),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:02:00.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:02:00.000Z',
      } as WorkerActionRecord;
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };

  return { store, events };
}

describe('pr-summary-refresh worker', () => {
  it('refreshes PR bodies only when content changes and records worker action state', async () => {
    const { store, events } = makeStore();
    let liveBody = 'old body';
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => liveBody),
      updateReviewBody: vi.fn(async ({ body }: { body: string }) => {
        liveBody = body;
      }),
    };
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    await refreshPrSummaries({ store, provider, logger });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(provider.updateReviewBody.mock.calls[0]?.[0]).toMatchObject({
      identifier: '42',
      cwd: '/tmp/worktree',
    });
    const updatedBody = provider.updateReviewBody.mock.calls[0]?.[0].body as string;
    expect(updatedBody).toContain('## Pipeline');
    expect(updatedBody).toContain('ci-failure');
    expect(updatedBody).not.toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(store.upsertWorkerAction.mock.calls.map((call) => call[0].status)).toEqual(['running', 'completed']);
    expect(events.at(-1)).toMatchObject({
      taskId: '__merge__wf-1',
      eventType: 'task.worker_action',
      payload: expect.objectContaining({
        worker: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
      }),
    });

    await refreshPrSummaries({ store, provider, logger });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(store.upsertWorkerAction.mock.calls.map((call) => call[0].status)).toEqual([
      'running',
      'completed',
      'running',
      'skipped',
    ]);
    expect(events.at(-1)?.payload).toMatchObject({
      status: 'skipped',
      reason: 'body-current',
    });
  });
});

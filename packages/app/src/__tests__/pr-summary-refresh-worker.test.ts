import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: vi.fn(),
};
logger.child.mockReturnValue(logger);

function makeTask(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'wf-1/build',
    description: 'Build feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    taskStateVersion: 1,
    config: { workflowId: 'wf-1', command: 'pnpm test', runnerKind: 'worktree' },
    execution: {},
    ...overrides,
  } as TaskState;
}

function makeStore(tasks: TaskState[], actions: WorkerActionRecord[]): {
  store: PrSummaryRefreshWorkerStore;
  savedActions: Map<string, WorkerActionRecord>;
  events: Array<{ taskId: string; eventType: string; payload?: unknown }>;
} {
  const savedActions = new Map<string, WorkerActionRecord>();
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  for (const action of actions) {
    savedActions.set(`${action.workerKind}:${action.externalKey}`, action);
  }
  const store: PrSummaryRefreshWorkerStore = {
    listWorkflows: () => [{ id: 'wf-1', name: 'Feature workflow', description: 'Ship worker visibility.' }],
    loadTasks: () => tasks,
    listWorkerActions: (filters = {}) => [...savedActions.values()].filter((action) => {
      if (filters.workflowId && action.workflowId !== filters.workflowId) return false;
      if (filters.taskId && action.taskId !== filters.taskId) return false;
      return true;
    }),
    getWorkerAction: (kind, key) => savedActions.get(`${kind}:${key}`),
    upsertWorkerAction: (write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = savedActions.get(key);
      const saved = {
        ...write,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:00:10.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:00:11.000Z',
      } as WorkerActionRecord;
      savedActions.set(key, saved);
      return saved;
    },
    logEvent: (taskId, eventType, payload) => {
      events.push({ taskId, eventType, payload });
    },
  };
  return { store, savedActions, events };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies once and records worker action state', async () => {
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true, summary: 'Merge summary', runnerKind: 'merge' },
      execution: {
        reviewUrl: 'https://github.com/org/repo/pull/123',
        workspacePath: '/tmp/repo',
        reviewGate: {
          activeGeneration: 1,
          completion: { required: 'all', status: 'approved' },
          artifacts: [{
            id: '123',
            providerId: '123',
            provider: 'github',
            url: 'https://github.com/org/repo/pull/123',
            required: true,
            status: 'open',
            generation: 1,
          }],
        },
      },
    });
    const buildTask = makeTask({ id: 'wf-1/build' });
    const action: WorkerActionRecord = {
      id: 'ci-1',
      workerKind: 'ci-failure',
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/build',
      subjectType: 'task',
      subjectId: 'wf-1/build',
      externalKey: 'ci-1',
      status: 'completed',
      attemptCount: 1,
      summary: 'Fixed CI failure',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:02.000Z',
      completedAt: '2026-01-01T00:00:02.000Z',
    };
    const harness = makeStore([buildTask, mergeTask], [action]);
    let liveBody = 'old body';
    const updateReviewBody = vi.fn(async ({ body }: { body: string }) => {
      liveBody = body;
    });
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => liveBody),
      updateReviewBody,
    };

    await refreshPrSummaries({ store: harness.store, provider, logger });
    expect(updateReviewBody).toHaveBeenCalledTimes(1);
    expect(liveBody).toContain('## Pipeline');
    expect(liveBody).toContain('ci-failure/fix-ci-failure');
    expect(liveBody).not.toContain(PR_SUMMARY_REFRESH_WORKER_KIND);

    updateReviewBody.mockClear();
    await refreshPrSummaries({ store: harness.store, provider, logger });
    expect(updateReviewBody).not.toHaveBeenCalled();

    const refreshAction = [...harness.savedActions.values()]
      .find((candidate) => candidate.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshAction).toMatchObject({
      actionType: 'refresh-pr-summary',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectId: '123',
      status: 'skipped',
      attemptCount: 2,
    });
    expect(harness.events.some((event) =>
      event.taskId === '__merge__wf-1' && event.eventType === 'task.worker_action')).toBe(true);
  });
});

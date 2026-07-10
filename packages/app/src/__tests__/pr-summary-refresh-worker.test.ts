import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  createPrSummaryRefreshTick,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Implement visibility',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test', ...(config ?? {}) },
    execution: { ...(execution ?? {}) },
    taskStateVersion: 1,
    ...rest,
  };
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      reviewGate: {
        activeGeneration: 0,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-12',
          providerId: '12',
          url: 'https://github.com/owner/repo/pull/12',
          required: true,
          status: 'open',
          generation: 0,
        }],
      },
    },
  });
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical pipeline content and records action state', async () => {
    const actions = new Map<string, WorkerActionRecord>();
    actions.set('ci-failure:ci-1', {
      id: 'ci-1',
      workerKind: 'ci-failure',
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      subjectType: 'review',
      subjectId: '12',
      externalKey: 'ci-1',
      status: 'queued',
      attemptCount: 1,
      summary: 'Queued CI repair',
      createdAt: '2026-01-01T00:00:01.000Z',
      updatedAt: '2026-01-01T00:00:01.000Z',
    });
    let liveBody = 'stale body';
    const updateReviewBody = vi.fn(async ({ body }: { body: string }) => {
      liveBody = body;
    });
    const logEvent = vi.fn();
    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow 1', description: 'Review visibility slice.' }]),
      loadTasks: vi.fn(() => [makeTask(), makeMergeTask()]),
      listWorkerActions: vi.fn(({ workflowId }: { workflowId?: string } = {}) =>
        [...actions.values()].filter((action) => !workflowId || action.workflowId === workflowId)),
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
        actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const key = `${write.workerKind}:${write.externalKey}`;
        const existing = actions.get(key);
        const saved: WorkerActionRecord = {
          ...write,
          attemptCount: write.attemptCount ?? 0,
          createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:00:02.000Z',
          updatedAt: write.updatedAt ?? '2026-01-01T00:00:02.000Z',
        };
        actions.set(key, saved);
        return saved;
      }),
      logEvent,
    };

    const tick = createPrSummaryRefreshTick({
      store,
      cwd: '/repo',
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() },
      mergeGateProvider: {
        name: 'test',
        createReview: vi.fn(),
        checkApproval: vi.fn(),
        getReviewBody: vi.fn(async () => liveBody),
        updateReviewBody,
      },
      now: () => new Date('2026-01-01T00:00:03.000Z'),
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(updateReviewBody).toHaveBeenCalledTimes(1);
    expect(liveBody).toContain('## Pipeline');
    expect(liveBody).toContain('ci-failure');
    expect(liveBody).toContain('Queued CI repair');
    expect(store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      taskId: '__merge__wf-1',
    }));
    expect(logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
    }));
  });
});

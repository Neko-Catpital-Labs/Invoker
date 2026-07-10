import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-1',
    description: 'Run tests',
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
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      workspacePath: '/repo',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [
          {
            id: 'pr-42',
            title: 'Visibility PR',
            url: 'https://github.com/owner/repo/pull/42',
            provider: 'github',
            providerId: '42',
            required: true,
            status: 'open',
            generation: 2,
          },
        ],
      },
    },
  });
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = '2026-01-01T00:10:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

describe('pr-summary-refresh worker', () => {
  it('updates PR body only when canonical Pipeline content changes and records action state', async () => {
    const mergeTask = makeMergeTask();
    const workerAction: WorkerActionRecord = {
      id: 'ci-1',
      workerKind: 'ci-failure',
      actionType: 'fix-ci-failure',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-1',
      subjectType: 'review',
      subjectId: '42',
      externalKey: 'ci:key',
      status: 'queued',
      attemptCount: 1,
      summary: 'Queued CI repair',
      createdAt: '2026-01-01T00:02:00.000Z',
      updatedAt: '2026-01-01T00:02:00.000Z',
    };
    const actions = new Map<string, WorkerActionRecord>([[`${workerAction.workerKind}:${workerAction.externalKey}`, workerAction]]);
    const logEvent = vi.fn();
    let liveBody = 'old body';
    const updateReviewBody = vi.fn(async ({ body }: { body: string }) => {
      liveBody = body;
    });
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => liveBody),
      updateReviewBody,
    };
    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Visibility workflow', description: 'Show operator actions.' }]),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Visibility workflow', description: 'Show operator actions.' })),
      loadTasks: vi.fn(() => [makeTask(), mergeTask]),
      listWorkerActions: vi.fn(() => [...actions.values()]),
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const key = `${write.workerKind}:${write.externalKey}`;
        const saved = toRecord(write, actions.get(key));
        actions.set(key, saved);
        return saved;
      }),
      logEvent,
    };

    const tick = createPrSummaryRefreshTick({
      store,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      mergeGateProvider: provider,
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(updateReviewBody).toHaveBeenCalledTimes(1);
    expect(liveBody).toContain('## Pipeline');
    expect(liveBody).toContain('| 2026-01-01T00:02:00.000Z | ci-failure | fix-ci-failure | queued | wf-1/task-1 | Queued CI repair |');
    const refreshWrites = store.upsertWorkerAction.mock.calls
      .map((call) => call[0])
      .filter((write) => write.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(refreshWrites.map((write) => write.status)).toEqual(['completed', 'skipped']);
    expect(logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
      }),
    );
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Implement feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    ...overrides,
  } as TaskState;
}

function makeWorkflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Workflow one',
    description: 'Workflow summary',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWorkerAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'ci-action',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'ci-key',
    status: 'queued',
    attemptCount: 1,
    summary: 'Queued CI repair',
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function makeStore(args: { workflow: Workflow; tasks: TaskState[]; actions: WorkerActionRecord[] }) {
  const actions = new Map(args.actions.map((action) => [`${action.workerKind}:${action.externalKey}`, action]));
  return {
    listWorkflows: vi.fn(() => [{ id: args.workflow.id }]),
    loadWorkflow: vi.fn(() => args.workflow),
    loadTasks: vi.fn(() => args.tasks),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) =>
      actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved: WorkerActionRecord = {
        id: write.id,
        workerKind: write.workerKind,
        actionType: write.actionType,
        ...(write.workflowId ? { workflowId: write.workflowId } : {}),
        ...(write.taskId ? { taskId: write.taskId } : {}),
        subjectType: write.subjectType,
        subjectId: write.subjectId,
        externalKey: write.externalKey,
        status: write.status,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        ...(write.summary ? { summary: write.summary } : {}),
        ...(write.payload !== undefined ? { payload: write.payload } : {}),
        createdAt: write.createdAt ?? existing?.createdAt ?? '2026-01-01T00:00:00.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
        ...(write.completedAt ? { completedAt: write.completedAt } : {}),
      };
      actions.set(`${saved.workerKind}:${saved.externalKey}`, saved);
      return saved;
    }),
    listWorkerActions: vi.fn((filters?: { workflowId?: string; limit?: number }) =>
      [...actions.values()]
        .filter((action) => !filters?.workflowId || action.workflowId === filters.workflowId)
        .slice(0, filters?.limit)),
    logEvent: vi.fn(),
  };
}

describe('pr-summary-refresh worker', () => {
  it('refreshes PR bodies only when rendered pipeline content changes', async () => {
    const workflow = makeWorkflow();
    const mergeTask = makeTask({
      id: '__merge__wf-1',
      description: 'Merge gate',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge', summary: 'Merge summary' },
      execution: {
        workspacePath: '/repo',
        reviewGate: {
          activeGeneration: 2,
          completion: { required: 'all', status: 'approved' },
          artifacts: [{
            id: 'pr-42',
            title: 'PR 42',
            url: 'https://github.com/owner/repo/pull/42',
            provider: 'github',
            providerId: '42',
            required: true,
            status: 'open',
            generation: 2,
            createdAt: '2026-01-01T00:00:00.000Z',
          }],
        },
      },
    });
    const store = makeStore({
      workflow,
      tasks: [makeTask(), mergeTask],
      actions: [makeWorkerAction()],
    });
    const provider = {
      name: 'github',
      createReview: vi.fn(),
      checkApproval: vi.fn(),
      getReviewBody: vi.fn(async () => 'old body'),
      updateReviewBody: vi.fn(async () => {}),
    };
    const tick = createPrSummaryRefreshTick({
      store,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      reviewProviders: { get: vi.fn(() => provider) },
      cwd: '/repo',
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const firstBody = provider.updateReviewBody.mock.calls[0]?.[0]?.body as string;
    expect(firstBody).toContain('## Pipeline');
    expect(firstBody).toContain('ci-failure');
    expect(firstBody).toContain('pr-summary-refresh');
    expect(store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectId: '42',
    }));
    expect(store.logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      reviewId: '42',
    }));

    provider.getReviewBody.mockResolvedValue(firstBody);
    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
  });
});

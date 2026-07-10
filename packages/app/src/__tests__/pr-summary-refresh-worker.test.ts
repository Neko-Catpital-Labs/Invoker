import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import type { MergeGateProvider } from '@invoker/execution-engine';
import {
  buildPrSummaryRefreshBody,
  createPrSummaryRefreshTick,
} from '@invoker/execution-engine';

function workflow(overrides: Partial<Workflow> = {}): Workflow {
  return {
    id: 'wf-1',
    name: 'Feature workflow',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-a',
    description: 'Implement task',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: { generation: 1 },
    taskStateVersion: 1,
    ...overrides,
  };
}

function mergeTask(overrides: Partial<TaskState> = {}): TaskState {
  return task({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge', summary: 'Merged workflow output' },
    execution: {
      generation: 1,
      workspacePath: '/tmp/repo',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-12',
          provider: 'github',
          providerId: '12',
          url: 'https://github.com/acme/repo/pull/12',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
    ...overrides,
  });
}

function workerAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'autofix:wf-1/task-a',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-a',
    subjectType: 'task',
    subjectId: 'wf-1/task-a',
    externalKey: 'wf-1/task-a',
    status: 'completed',
    attemptCount: 1,
    summary: 'Applied fix',
    payload: {},
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    ...overrides,
  };
}

function makeHarness(options: { currentBody?: string } = {}) {
  const wf = workflow();
  const leaf = task();
  const merge = mergeTask();
  const actions = new Map<string, WorkerActionRecord>([
    ['autofix:wf-1/task-a', workerAction()],
  ]);
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const provider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => options.currentBody ?? 'old body'),
    updateReviewBody: vi.fn(async () => undefined),
  } as unknown as MergeGateProvider & {
    getReviewBody: ReturnType<typeof vi.fn>;
    updateReviewBody: ReturnType<typeof vi.fn>;
  };
  const store = {
    listWorkflows: vi.fn(() => [wf]),
    loadTasks: vi.fn(() => [leaf, merge]),
    listWorkerActions: vi.fn((filters?: { workflowId?: string; workerKind?: string; limit?: number }) => {
      let rows = [...actions.values()];
      if (filters?.workflowId) rows = rows.filter((action) => action.workflowId === filters.workflowId);
      if (filters?.workerKind) rows = rows.filter((action) => action.workerKind === filters.workerKind);
      rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      return rows.slice(0, filters?.limit ?? rows.length);
    }),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const now = write.updatedAt ?? '2026-01-01T00:00:03.000Z';
      const record: WorkerActionRecord = {
        ...write,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: now,
      };
      actions.set(`${record.workerKind}:${record.externalKey}`, record);
      return record;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  const logger = { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as unknown as Logger;
  const tick = createPrSummaryRefreshTick({ logger, store, mergeGateProvider: provider });
  return { wf, leaf, merge, actions, events, provider, store, tick };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical pipeline actions and records action state', async () => {
    const h = makeHarness();

    await h.tick({
      identity: { kind: 'pr-summary-refresh', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
    });

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = h.provider.updateReviewBody.mock.calls[0]?.[0]?.body;
    expect(body).toContain('## Pipeline');
    expect(body).toContain('autofix');
    expect(body).toContain('Applied fix');
    expect(h.store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: 'pr-summary-refresh',
      actionType: 'review-body-refresh',
      status: 'completed',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
    }));
    expect(h.events.some((event) => event.eventType === 'task.worker_action')).toBe(true);
  });

  it('does not update when the published body is already current', async () => {
    const base = makeHarness();
    const currentBody = buildPrSummaryRefreshBody({
      workflow: base.wf,
      tasks: [base.leaf, base.merge],
      mergeTask: base.merge,
      workerActions: [...base.actions.values()],
    });
    const h = makeHarness({ currentBody });

    await h.tick({
      identity: { kind: 'pr-summary-refresh', instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
    });

    expect(h.provider.updateReviewBody).not.toHaveBeenCalled();
    expect(h.store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: 'pr-summary-refresh',
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'body-current' }),
    }));
  });
});

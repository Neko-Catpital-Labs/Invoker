import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildPrSummaryRefreshBody,
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
} from '@invoker/execution-engine';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-1/task-a',
    description: 'Run tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test', ...(config ?? {}) },
    execution: { generation: 0, ...(execution ?? {}) },
    taskStateVersion: 1,
    ...rest,
  } as TaskState;
}

function makeMergeTask(overrides: Partial<TaskState> = {}): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    dependencies: ['wf-1/task-a'],
    config: { workflowId: 'wf-1', isMergeNode: true, summary: 'Merged completed tasks.' },
    execution: {
      generation: 2,
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      workspacePath: '/tmp/repo',
    },
    ...overrides,
  });
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = write.updatedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: now,
  };
}

function makeHarness(opts: {
  liveBody?: string;
  workflow?: Partial<Workflow>;
  workerActions?: WorkerActionRecord[];
} = {}) {
  const workflow = {
    id: 'wf-1',
    name: 'Workflow One',
    description: 'Workflow description.',
    status: 'running',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...(opts.workflow ?? {}),
  } as Workflow;
  const mergeTask = makeMergeTask();
  const tasks = [makeTask(), mergeTask];
  const actions = new Map<string, WorkerActionRecord>();
  for (const action of opts.workerActions ?? []) {
    actions.set(`${action.workerKind}:${action.externalKey}`, action);
  }
  const store = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn((workflowId: string) => workflowId === workflow.id ? workflow : undefined),
    loadTasks: vi.fn((workflowId: string) => workflowId === workflow.id ? tasks : []),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn((filters?: { workflowId?: string }) =>
      [...actions.values()].filter((action) => !filters?.workflowId || action.workflowId === filters.workflowId),
    ),
    logEvent: vi.fn(),
  };
  const provider = {
    name: 'github',
    getReviewBody: vi.fn(async () => opts.liveBody ?? 'old body'),
    updateReviewBody: vi.fn(async () => {}),
  };
  return { actions, mergeTask, provider, store };
}

function actionRecord(overrides: Partial<WorkerActionRecord>): WorkerActionRecord {
  return {
    id: 'worker-action',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'task',
    subjectId: '__merge__wf-1',
    externalKey: 'ci-key',
    status: 'queued',
    attemptCount: 1,
    summary: 'Queued CI repair',
    payload: { reason: 'ci-failed' },
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

describe('pr-summary-refresh worker', () => {
  it('updates the PR body only when rendered canonical content changed', async () => {
    const harness = makeHarness({
      workerActions: [
        actionRecord({
          workerKind: 'autofix',
          actionType: 'auto-fix',
          status: 'completed',
          externalKey: 'autofix-key',
          updatedAt: '2026-01-01T00:02:00.000Z',
          summary: 'Fixed failed task',
        }),
      ],
    });
    const tick = createPrSummaryRefreshTick({
      store: harness.store,
      provider: harness.provider,
      logger,
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const update = harness.provider.updateReviewBody.mock.calls[0][0];
    expect(update).toMatchObject({ identifier: '123', cwd: '/tmp/repo' });
    expect(update.body).toContain('## Pipeline');
    expect(update.body).toContain('| 2026-01-01T00:02:00.000Z | autofix | auto-fix | __merge__wf-1 | completed | Fixed failed task |');
    expect([...harness.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND))
      .toMatchObject({ status: 'completed', summary: 'Updated PR Pipeline summary', attemptCount: 1 });
    expect(harness.store.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
        status: 'completed',
        summary: 'Updated PR Pipeline summary',
        reviewId: '123',
      }),
    );
  });

  it('skips provider update when the canonical body is already current', async () => {
    const seedAction = actionRecord({
      updatedAt: '2026-01-01T00:01:00.000Z',
    });
    const expected = makeHarness({ workerActions: [seedAction] });
    const liveBody = buildPrSummaryRefreshBody(expected.store, {
      workflowId: 'wf-1',
      mergeTask: expected.mergeTask,
      reviewId: '123',
      cwd: '/tmp/repo',
    });
    const harness = makeHarness({ liveBody, workerActions: [seedAction] });
    const tick = createPrSummaryRefreshTick({
      store: harness.store,
      provider: harness.provider,
      logger,
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.provider.updateReviewBody).not.toHaveBeenCalled();
    expect([...harness.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND))
      .toMatchObject({ status: 'skipped', summary: 'PR Pipeline summary already current' });
  });
});

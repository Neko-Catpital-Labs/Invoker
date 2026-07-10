import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { MergeGateProvider } from '@invoker/execution-engine';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

const logger: Logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: () => logger,
};

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    id: overrides.id,
    description: overrides.description ?? overrides.id,
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    config: overrides.config ?? { workflowId: 'wf-1' },
    execution: overrides.execution ?? {},
    createdAt: overrides.createdAt ?? new Date('2026-01-01T00:00:00.000Z'),
  } as TaskState;
}

function makeAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: overrides.id ?? 'wa-autofix',
    workerKind: overrides.workerKind ?? 'auto-fix',
    actionType: overrides.actionType ?? 'fix-task',
    workflowId: overrides.workflowId ?? 'wf-1',
    taskId: overrides.taskId ?? 'wf-1/build',
    subjectType: overrides.subjectType ?? 'task',
    subjectId: overrides.subjectId ?? 'wf-1/build',
    externalKey: overrides.externalKey ?? 'auto-fix:wf-1/build',
    status: overrides.status ?? 'completed',
    attemptCount: overrides.attemptCount ?? 1,
    summary: overrides.summary ?? 'Submitted AI repair',
    payload: overrides.payload,
    createdAt: overrides.createdAt ?? '2026-01-01T00:01:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-01-01T00:01:00.000Z',
    completedAt: overrides.completedAt,
  };
}

function makeStore(): {
  store: PrSummaryRefreshWorkerStore;
  actions: Map<string, WorkerActionRecord>;
  writes: WorkerActionWrite[];
  logEvent: ReturnType<typeof vi.fn>;
} {
  const actions = new Map<string, WorkerActionRecord>();
  actions.set('auto-fix:auto-fix:wf-1/build', makeAction());
  const writes: WorkerActionWrite[] = [];
  const mergeTask = makeTask({
    id: '__merge__wf-1',
    description: 'Review PR',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      reviewId: '42',
      reviewUrl: 'https://github.com/owner/repo/pull/42',
      workspacePath: '/repo',
    },
  });
  const buildTask = makeTask({
    id: 'wf-1/build',
    description: 'Run build',
    status: 'completed',
    config: { workflowId: 'wf-1', command: 'pnpm build' },
  });
  const logEvent = vi.fn();
  const store: PrSummaryRefreshWorkerStore = {
    listWorkflows: vi.fn(() => [{
      id: 'wf-1',
      name: 'Worker summary',
      description: 'Show Invoker worker activity on the PR.',
      repoUrl: 'https://github.com/owner/repo.git',
    }]),
    loadTasks: vi.fn(() => [buildTask, mergeTask]),
    listWorkerActions: vi.fn((filters?: { workflowId?: string }) => [...actions.values()].filter(
      (action) => !filters?.workflowId || action.workflowId === filters.workflowId,
    )),
    getWorkerAction: vi.fn((kind: string, key: string) => actions.get(`${kind}:${key}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      writes.push(write);
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved: WorkerActionRecord = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:02:00.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:02:00.000Z',
      };
      actions.set(key, saved);
      return saved;
    }),
    logEvent,
  };
  return { store, actions, writes, logEvent };
}

function makeProvider(currentBodyRef: { value: string }): MergeGateProvider {
  return {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => currentBodyRef.value),
    updateReviewBody: vi.fn(async ({ body }) => {
      currentBodyRef.value = body;
    }),
  };
}

describe('pr-summary-refresh worker', () => {
  it('refreshes changed PR bodies with canonical worker action pipeline evidence', async () => {
    const currentBody = { value: 'old body' };
    const provider = makeProvider(currentBody);
    const { store, writes, logEvent } = makeStore();

    await refreshPrSummaries({ store, logger, provider, cwd: '/repo' });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = vi.mocked(provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body).toContain('auto-fix');
    expect(body).toContain('Submitted AI repair');
    expect(body).not.toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'pr-summary-refresh',
      status: 'completed',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'pull_request',
      subjectId: '42',
    });
    expect(logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      reviewId: '42',
    }));
  });

  it('does not update the provider when the rendered body is unchanged', async () => {
    const currentBody = { value: 'old body' };
    const provider = makeProvider(currentBody);
    const { store, writes } = makeStore();

    await refreshPrSummaries({ store, logger, provider, cwd: '/repo' });
    vi.mocked(provider.updateReviewBody).mockClear();

    await refreshPrSummaries({ store, logger, provider, cwd: '/repo' });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    expect(writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'pr-body-current' }),
    });
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import {
  createPrSummaryRefreshWorker,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type MergeGateProvider,
} from '@invoker/execution-engine';

function logger(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger(),
  };
}

function task(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Implement task',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function action(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'wa-1',
    workerKind: 'autofix',
    actionType: 'fix-task',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'autofix-key',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed task failure',
    payload: { reason: 'test-failure' },
    createdAt: '2026-01-01T00:00:01.000Z',
    updatedAt: '2026-01-01T00:00:02.000Z',
    completedAt: '2026-01-01T00:00:02.000Z',
    ...overrides,
  };
}

function harness(initialBody = 'old body') {
  const workflow: Workflow = {
    id: 'wf-1',
    name: 'Workflow One',
    description: 'Refresh the PR summary.',
    status: 'running',
    repoUrl: 'https://github.com/example/repo.git',
    baseBranch: 'main',
    featureBranch: 'feature/pr-summary',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
  const merge = task({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      workspacePath: '/repo',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          title: 'Workflow One',
          providerId: '123',
          provider: 'github',
          url: 'https://github.com/example/repo/pull/123',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
  });
  const actions = new Map<string, WorkerActionRecord>();
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const listWorkerActions = vi.fn(() => [action(), ...[...actions.values()]]);
  const store = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn(() => workflow),
    loadTasks: vi.fn(() => [
      task({ id: 'wf-1/task-1', status: 'completed' }),
      merge,
    ]),
    listWorkerActions,
    getWorkerAction: vi.fn((kind: string, key: string) => actions.get(`${kind}:${key}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved: WorkerActionRecord = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? '2026-01-01T00:00:10.000Z',
        updatedAt: write.updatedAt ?? '2026-01-01T00:00:10.000Z',
      } as WorkerActionRecord;
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  let body = initialBody;
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => body),
    updateReviewBody: vi.fn(async (opts) => {
      body = opts.body;
    }),
  } as unknown as MergeGateProvider;

  return { actions, events, provider, store, get body() { return body; } };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with worker pipeline rows and records action state', async () => {
    const h = harness();
    const worker = createPrSummaryRefreshWorker({
      logger: logger(),
      store: h.store,
      reviewProvider: h.provider,
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(h.body).toContain('## Pipeline');
    expect(h.body).toContain('| autofix | fix-task |');
    expect(h.body).toContain('Fixed task failure (test-failure)');
    expect(h.store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
    }));
    expect(h.events.some((event) => event.eventType === 'task.worker_action')).toBe(true);
  });

  it('skips provider updates when the rendered body is unchanged', async () => {
    const h = harness();
    const worker = createPrSummaryRefreshWorker({
      logger: logger(),
      store: h.store,
      reviewProvider: h.provider,
      installSignalHandlers: false,
    });

    await worker.tick();
    await worker.tick();

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(h.store.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'unchanged' }),
    }));
  });
});

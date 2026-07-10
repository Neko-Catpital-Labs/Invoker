import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildPrSummaryRefreshBody,
  refreshPrSummaries,
  type PrSummaryRefreshProvider,
} from '@invoker/execution-engine';

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Task one',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    taskStateVersion: 1,
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: { branch: 'task-branch', exitCode: 0 },
    ...overrides,
  } as TaskState;
}

function makeMergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge wf-1',
    status: 'review_ready',
    config: {
      workflowId: 'wf-1',
      isMergeNode: true,
      runnerKind: 'merge',
      summary: 'Merged workflow summary.',
    },
    execution: {
      workspacePath: '/tmp/review-workspace',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '42',
          title: 'Review PR',
          url: 'https://github.com/owner/repo/pull/42',
          providerId: '42',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
  });
}

const workerAction: WorkerActionRecord = {
  id: 'ci-action',
  workerKind: 'ci-failure',
  actionType: 'fix-ci-failure',
  workflowId: 'wf-1',
  taskId: 'wf-1/task-1',
  subjectType: 'task',
  subjectId: 'wf-1/task-1',
  externalKey: 'ci:wf-1/task-1',
  status: 'completed',
  attemptCount: 1,
  summary: 'Fixed failing CI',
  createdAt: '2026-01-01T00:01:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  completedAt: '2026-01-01T00:02:00.000Z',
};

function makeHarness(provider: PrSummaryRefreshProvider) {
  const saved = new Map<string, WorkerActionRecord>();
  const upserts: WorkerActionWrite[] = [];
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const mergeTask = makeMergeTask();
  const task = makeTask();
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Workflow One', description: 'Workflow description.' })),
    loadTasks: vi.fn(() => [task, mergeTask]),
    listWorkerActions: vi.fn(() => [workerAction, ...saved.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => saved.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      upserts.push(write);
      const existing = saved.get(`${write.workerKind}:${write.externalKey}`);
      const now = write.updatedAt ?? '2026-01-01T00:03:00.000Z';
      const record: WorkerActionRecord = {
        ...write,
        attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: now,
      };
      saved.set(`${write.workerKind}:${write.externalKey}`, record);
      return record;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  return {
    store,
    provider,
    task,
    mergeTask,
    upserts,
    events,
  };
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
};

describe('pr-summary-refresh worker', () => {
  it('updates a PR body when canonical pipeline content changes and records action state', async () => {
    const provider: PrSummaryRefreshProvider = {
      name: 'github',
      getReviewBody: vi.fn(async () => 'stale body'),
      updateReviewBody: vi.fn(async () => {}),
    };
    const harness = makeHarness(provider);

    await refreshPrSummaries({ logger, store: harness.store, mergeGateProvider: provider });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = vi.mocked(provider.updateReviewBody).mock.calls[0]?.[0].body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body).toContain('ci-failure/fix-ci-failure');
    expect(body).toContain('Fixed failing CI');
    expect(harness.upserts.map((write) => write.status)).toEqual(['running', 'completed']);
    expect(harness.events).toEqual(expect.arrayContaining([
      expect.objectContaining({ taskId: '__merge__wf-1', eventType: 'task.worker_action' }),
    ]));
  });

  it('skips provider updates when the PR body is already current', async () => {
    const mergeTask = makeMergeTask();
    const currentBody = buildPrSummaryRefreshBody({
      workflowId: 'wf-1',
      workflow: { id: 'wf-1', name: 'Workflow One', description: 'Workflow description.' },
      mergeTask,
      tasks: [makeTask(), mergeTask],
      workerActions: [workerAction],
    });
    const provider: PrSummaryRefreshProvider = {
      name: 'github',
      getReviewBody: vi.fn(async () => currentBody),
      updateReviewBody: vi.fn(async () => {}),
    };
    const harness = makeHarness(provider);

    await refreshPrSummaries({ logger, store: harness.store, mergeGateProvider: provider });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    expect(harness.upserts).toHaveLength(1);
    expect(harness.upserts[0]).toMatchObject({
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'no-content-change' }),
    });
  });
});

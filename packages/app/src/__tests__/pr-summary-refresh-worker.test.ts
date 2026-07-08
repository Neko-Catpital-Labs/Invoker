import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  buildPrSummaryRefreshBody,
  createPrSummaryRefreshTick,
  prSummaryRefreshActionKey,
  type PrSummaryRefreshProvider,
} from '@invoker/execution-engine';

const workflow: Workflow = {
  id: 'wf-1',
  name: 'PR Pipeline summary',
  description: 'Show what Invoker did.',
  status: 'review_ready',
  rollup: undefined,
  baseBranch: 'main',
  featureBranch: 'feature/pr-summary',
  onFinish: 'pull_request',
  mergeMode: 'external_review',
  generation: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const mergeTask = {
  id: '__merge__wf-1',
  description: 'Review gate',
  status: 'review_ready',
  dependencies: ['wf-1/task-1'],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  config: { workflowId: 'wf-1', isMergeNode: true },
  execution: {
    generation: 3,
    branch: 'feature/pr-summary',
    reviewId: '101',
    reviewUrl: 'https://github.com/owner/repo/pull/101',
    workspacePath: '/tmp/repo',
  },
  taskStateVersion: 1,
} as TaskState;

const completedTask = {
  id: 'wf-1/task-1',
  description: 'Implement feature',
  status: 'completed',
  dependencies: [],
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  config: { workflowId: 'wf-1', command: 'pnpm test' },
  execution: {},
  taskStateVersion: 1,
} as TaskState;

const workerAction: WorkerActionRecord = {
  id: 'wa-coderabbit',
  workerKind: 'coderabbit-update',
  actionType: 'address-coderabbit-feedback',
  workflowId: 'wf-1',
  taskId: '__merge__wf-1',
  subjectType: 'pull_request',
  subjectId: '101',
  externalKey: 'coderabbit:101:2026-01-01T00:01:00.000Z',
  status: 'completed',
  attemptCount: 1,
  summary: 'CodeRabbit feedback addressed and pushed',
  createdAt: '2026-01-01T00:01:00.000Z',
  updatedAt: '2026-01-01T00:02:00.000Z',
  completedAt: '2026-01-01T00:02:00.000Z',
};

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
};

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? '2026-01-01T00:03:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:03:00.000Z',
  };
}

function makeStore() {
  const actions = new Map<string, WorkerActionRecord>([
    [`${workerAction.workerKind}:${workerAction.externalKey}`, workerAction],
  ]);
  const logEvent = vi.fn();
  const store = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn(() => workflow),
    loadTasks: vi.fn(() => [mergeTask, completedTask]),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent,
  };
  return { actions, store, logEvent };
}

function makeProvider(currentBody: string): PrSummaryRefreshProvider & {
  updatedBodies: string[];
} {
  const updatedBodies: string[] = [];
  return {
    name: 'github',
    updatedBodies,
    getReviewBody: vi.fn(async () => currentBody),
    updateReviewBody: vi.fn(async ({ body }) => {
      updatedBodies.push(body);
    }),
  };
}

describe('PR summary refresh worker', () => {
  it('refreshes changed PR bodies with a canonical Pipeline section and records action state', async () => {
    const h = makeStore();
    const provider = makeProvider('old body');
    const tick = createPrSummaryRefreshTick({
      store: h.store,
      logger,
      provider,
      now: () => new Date('2026-01-01T00:04:00.000Z'),
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(provider.updatedBodies[0]).toContain('## Pipeline');
    expect(provider.updatedBodies[0]).toContain('coderabbit-update');
    expect(provider.updatedBodies[0]).toContain('CodeRabbit feedback addressed and pushed');

    const key = prSummaryRefreshActionKey('wf-1', '101', 3);
    expect(h.actions.get(`${PR_SUMMARY_REFRESH_WORKER_KIND}:${key}`)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      taskId: '__merge__wf-1',
      subjectId: '101',
      payload: expect.objectContaining({
        changed: true,
        pipelineActionCount: 1,
      }),
    });
    expect(h.logEvent).toHaveBeenCalledWith(
      '__merge__wf-1',
      'task.worker_action',
      expect.objectContaining({
        worker: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
        prNumber: '101',
      }),
    );
  });

  it('skips provider updates when the live body is already current', async () => {
    const h = makeStore();
    const currentBody = buildPrSummaryRefreshBody({
      workflow,
      tasks: [mergeTask, completedTask],
      workerActions: [workerAction],
    });
    const provider = makeProvider(currentBody);

    await createPrSummaryRefreshTick({
      store: h.store,
      logger,
      provider,
      now: () => new Date('2026-01-01T00:05:00.000Z'),
    })({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    const key = prSummaryRefreshActionKey('wf-1', '101', 3);
    expect(h.actions.get(`${PR_SUMMARY_REFRESH_WORKER_KIND}:${key}`)).toMatchObject({
      status: 'skipped',
      summary: 'PR summary already current',
      attemptCount: 0,
    });
  });
});

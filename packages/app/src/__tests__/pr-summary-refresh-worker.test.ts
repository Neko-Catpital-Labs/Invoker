import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';
import type {
  MergeGateProvider,
  WorkerStateStore,
} from '@invoker/execution-engine';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  buildPrSummaryRefreshBody,
  createPrSummaryRefreshTick,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeWorkflow(): Workflow {
  return {
    id: 'wf-1',
    name: 'Pipeline visibility',
    description: 'Show what Invoker did on the PR.',
    status: 'review_ready',
    onFinish: 'pull_request',
    mergeMode: 'external_review',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

function makeMergeTask(): TaskState {
  return {
    id: 'wf-1/__merge__',
    description: 'merge',
    status: 'review_ready',
    dependencies: ['wf-1/test'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      isMergeNode: true,
      summary: 'Merged workflow changes.',
    },
    execution: {
      workspacePath: '/repo',
      reviewId: '301',
      reviewUrl: 'https://github.com/owner/repo/pull/301',
      reviewGate: {
        activeGeneration: 2,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-301',
          title: 'Pipeline visibility',
          url: 'https://github.com/owner/repo/pull/301',
          providerId: '301',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      },
    },
    taskStateVersion: 1,
  } as TaskState;
}

function makeTask(): TaskState {
  return {
    id: 'wf-1/test',
    description: 'Run focused tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test --filter worker' },
    execution: {},
    taskStateVersion: 1,
  } as TaskState;
}

function makeAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'action-1',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/test',
    subjectType: 'review',
    subjectId: '301',
    externalKey: 'ci-failure:wf-1/test:301',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed failing CI',
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:10:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(currentBody = 'old body') {
  const workflow = makeWorkflow();
  const mergeTask = makeMergeTask();
  const task = makeTask();
  const actions = new Map<string, WorkerActionRecord>();
  actions.set('ci-failure:ci-failure:wf-1/test:301', makeAction());
  actions.set('coderabbit-update:coderabbit:wf-1:301', makeAction({
    id: 'action-2',
    workerKind: 'coderabbit-update',
    actionType: 'address-coderabbit-feedback',
    taskId: mergeTask.id,
    subjectType: 'pull_request',
    subjectId: '301',
    externalKey: 'coderabbit:wf-1:301',
    summary: 'Addressed CodeRabbit feedback',
    updatedAt: '2026-01-01T00:02:00.000Z',
    completedAt: '2026-01-01T00:02:00.000Z',
  }));

  const store: WorkerStateStore = {
    listWorkflows: vi.fn(() => [{ id: workflow.id }]),
    loadWorkflow: vi.fn(() => workflow),
    loadTasks: vi.fn((workflowId) => workflowId === workflow.id ? [task, mergeTask] : []),
    loadTask: vi.fn((taskId) => [task, mergeTask].find((candidate) => candidate.id === taskId)),
    findReviewGateByPr: vi.fn(),
    getWorkerAction: vi.fn((workerKind, externalKey) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(key, saved);
      return saved;
    }),
    listWorkerActions: vi.fn((filters) => [...actions.values()].filter((action) =>
      (!filters?.workflowId || action.workflowId === filters.workflowId)
      && (!filters?.workerKind || action.workerKind === filters.workerKind),
    )),
    logEvent: vi.fn(),
  };
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => currentBody),
    updateReviewBody: vi.fn(async () => {}),
  } as unknown as MergeGateProvider;
  return { workflow, mergeTask, task, actions, store, provider };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with Pipeline rows and records action state', async () => {
    const h = makeHarness();
    const tick = createPrSummaryRefreshTick({
      store: h.store,
      mergeGateProvider: h.provider,
      logger,
      cwd: '/fallback',
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.provider.getReviewBody).toHaveBeenCalledWith({ identifier: '301', cwd: '/repo' });
    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = vi.mocked(h.provider.updateReviewBody!).mock.calls[0][0].body;
    expect(body).toContain('## Pipeline');
    expect(body).toContain('ci-failure | fix-ci-failure');
    expect(body).toContain('coderabbit-update | address-coderabbit-feedback');
    expect(body.indexOf('ci-failure | fix-ci-failure')).toBeLessThan(
      body.indexOf('coderabbit-update | address-coderabbit-feedback'),
    );
    expect([...h.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND)).toMatchObject({
      status: 'completed',
      taskId: h.mergeTask.id,
      subjectId: '301',
      attemptCount: 1,
    });
    expect(h.store.logEvent).toHaveBeenCalledWith(
      h.mergeTask.id,
      'task.worker_action',
      expect.objectContaining({
        worker: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
      }),
    );
  });

  it('does not update provider body when canonical summary is already current', async () => {
    const seed = makeHarness();
    const currentBody = buildPrSummaryRefreshBody({
      workflow: seed.workflow,
      mergeTask: seed.mergeTask,
      workflowTasks: [seed.task, seed.mergeTask],
      workerActions: [...seed.actions.values()],
    });
    const h = makeHarness(currentBody);
    const tick = createPrSummaryRefreshTick({
      store: h.store,
      mergeGateProvider: h.provider,
      logger,
    });

    await tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.provider.updateReviewBody).not.toHaveBeenCalled();
    expect([...h.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND)).toMatchObject({
      status: 'skipped',
      summary: 'Skipped PR summary refresh because the body is already current',
    });
  });
});

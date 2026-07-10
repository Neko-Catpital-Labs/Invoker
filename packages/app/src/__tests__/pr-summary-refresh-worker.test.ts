import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  ReviewProviderRegistry,
  type MergeGateProvider,
} from '@invoker/execution-engine';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeMergeTask(): TaskState {
  return {
    id: 'wf-1/__merge__',
    description: 'Merge',
    status: 'review_ready',
    dependencies: ['wf-1/task-1'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      generation: 1,
      workspacePath: '/tmp/repo',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          provider: 'github',
          providerId: '123',
          url: 'https://github.com/owner/repo/pull/123',
          required: true,
          status: 'open',
          generation: 1,
          createdAt: '2026-01-01T00:00:00.000Z',
        }],
      },
    },
    taskStateVersion: 1,
  } as TaskState;
}

function makeBuildTask(): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Build feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    taskStateVersion: 1,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(currentBody = 'old body') {
  const actions = new Map<string, WorkerActionRecord>();
  const writes: WorkerActionWrite[] = [];
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const bodyRef = { current: currentBody };
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(async () => ({ url: '', identifier: '' })),
    checkApproval: vi.fn(async () => ({
      lifecycle: 'open',
      rejected: false,
      statusText: 'Awaiting review',
      url: 'https://github.com/owner/repo/pull/123',
    })),
    getReviewBody: vi.fn(async () => bodyRef.current),
    updateReviewBody: vi.fn(async ({ body }) => {
      bodyRef.current = body;
    }),
  };
  const registry = new ReviewProviderRegistry();
  registry.register(provider);
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Worker summary', description: 'Pipeline visibility' }]),
    loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Worker summary', description: 'Pipeline visibility' })),
    loadTasks: vi.fn(() => [makeBuildTask(), makeMergeTask()]),
    listWorkerActions: vi.fn(() => [
      {
        id: 'late',
        workerKind: 'ci-failure',
        actionType: 'fix-ci-failure',
        workflowId: 'wf-1',
        taskId: 'wf-1/__merge__',
        subjectType: 'review',
        subjectId: '123',
        externalKey: 'late',
        status: 'queued',
        attemptCount: 1,
        summary: 'Queued CI repair',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:10:00.000Z',
      },
      {
        id: 'self',
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
        workflowId: 'wf-1',
        taskId: 'wf-1/__merge__',
        subjectType: 'review',
        subjectId: '123',
        externalKey: 'self',
        status: 'completed',
        attemptCount: 1,
        summary: 'Previous summary refresh',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:20:00.000Z',
      },
      {
        id: 'early',
        workerKind: 'autofix',
        actionType: 'auto-fix',
        workflowId: 'wf-1',
        taskId: 'wf-1/task-1',
        subjectType: 'task',
        subjectId: 'wf-1/task-1',
        externalKey: 'early',
        status: 'completed',
        attemptCount: 1,
        summary: 'Fixed task',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:01:00.000Z',
      },
    ] as WorkerActionRecord[]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      writes.push(write);
      const existing = actions.get(`${write.workerKind}:${write.externalKey}`);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  const tick = createPrSummaryRefreshTick({ store, reviewProviderRegistry: registry, logger });
  return { bodyRef, provider, store, writes, events, tick };
}

describe('pr-summary-refresh worker', () => {
  it('updates stale PR bodies with canonical pipeline worker actions', async () => {
    const harness = makeHarness();

    await harness.tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(harness.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(harness.bodyRef.current).toContain('## Pipeline');
    const early = harness.bodyRef.current.indexOf('| 2026-01-01T00:01:00.000Z | autofix | auto-fix | wf-1/task-1 | completed | Fixed task |');
    const late = harness.bodyRef.current.indexOf('| 2026-01-01T00:10:00.000Z | ci-failure | fix-ci-failure | wf-1/__merge__ | queued | Queued CI repair |');
    expect(early).toBeGreaterThan(-1);
    expect(late).toBeGreaterThan(-1);
    expect(early).toBeLessThan(late);
    expect(harness.bodyRef.current).not.toContain('Previous summary refresh');
    expect(harness.writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      taskId: 'wf-1/__merge__',
    });
    expect(harness.events.at(-1)).toMatchObject({
      taskId: 'wf-1/__merge__',
      eventType: 'task.worker_action',
    });
  });

  it('skips provider updates when the canonical body is already current', async () => {
    const harness = makeHarness();
    await harness.tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });
    vi.mocked(harness.provider.updateReviewBody!).mockClear();

    await harness.tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 2 });

    expect(harness.provider.updateReviewBody).not.toHaveBeenCalled();
    expect(harness.writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      payload: expect.objectContaining({ reason: 'content-unchanged' }),
    });
  });
});

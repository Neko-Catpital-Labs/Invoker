import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildCanonicalPrBody,
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type MergeGateProvider,
} from '@invoker/execution-engine';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Run tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: {
      workflowId: 'wf-1',
      command: 'pnpm test',
    },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = write.updatedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id: write.id,
    workerKind: write.workerKind,
    actionType: write.actionType,
    workflowId: write.workflowId,
    taskId: write.taskId,
    subjectType: write.subjectType,
    subjectId: write.subjectId,
    externalKey: write.externalKey,
    status: write.status,
    attemptCount: write.attemptCount ?? 0,
    intentId: write.intentId,
    agentName: write.agentName,
    executionModel: write.executionModel,
    sessionId: write.sessionId,
    summary: write.summary,
    payload: write.payload,
    createdAt: write.createdAt ?? now,
    updatedAt: now,
    completedAt: write.completedAt,
  };
}

function harness(existingBody = 'old body') {
  const mergeTask = makeTask({
    id: '__merge__wf-1',
    description: 'Merge gate',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      reviewId: '123',
      reviewUrl: 'https://github.com/owner/repo/pull/123',
      generation: 2,
      selectedAttemptId: 'attempt-1',
      workspacePath: '/repo/worktree',
    },
  });
  const workerAction: WorkerActionRecord = {
    id: 'wa-1',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'ci:wf-1/task-1',
    status: 'queued',
    attemptCount: 1,
    summary: 'Queued CI repair',
    payload: { reason: 'failed-check' },
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
  };
  const actions = new Map<string, WorkerActionRecord>([[`${workerAction.workerKind}:${workerAction.externalKey}`, workerAction]]);
  const writes: WorkerActionWrite[] = [];
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store = {
    listWorkflows: vi.fn(() => [{ id: 'wf-1' }]),
    loadWorkflow: vi.fn(() => ({
      id: 'wf-1',
      name: 'Workflow One',
      description: 'Workflow summary.',
    })),
    loadTasks: vi.fn(() => [makeTask(), mergeTask]),
    listWorkerActions: vi.fn(() => Array.from(actions.values())),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      writes.push(write);
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(async () => ({ url: 'https://github.com/owner/repo/pull/123', identifier: '123' })),
    checkApproval: vi.fn(async () => ({
      lifecycle: 'open',
      rejected: false,
      statusText: 'Awaiting review',
      url: 'https://github.com/owner/repo/pull/123',
    })),
    getReviewBody: vi.fn(async () => existingBody),
    updateReviewBody: vi.fn(async () => {}),
  };
  const tick = createPrSummaryRefreshTick({
    store,
    logger,
    mergeGateProvider: provider,
    cwd: '/repo',
  });
  return { tick, store, provider, writes, events };
}

describe('pr-summary-refresh worker', () => {
  it('updates a PR body only when rendered pipeline content differs', async () => {
    const h = harness('old body');

    await h.tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const update = vi.mocked(h.provider.updateReviewBody).mock.calls[0]?.[0];
    expect(update).toMatchObject({ identifier: '123', cwd: '/repo/worktree' });
    expect(update?.body).toContain('## Pipeline');
    expect(update?.body).toContain('ci-failure | fix-ci-failure');
    expect(update?.body).toContain('Queued CI repair (failed-check)');
    expect(h.writes.map((write) => write.status)).toEqual(['running', 'completed']);
    expect(h.events.some((event) => event.eventType === 'task.worker_action')).toBe(true);
  });

  it('skips provider updates when the canonical body is unchanged', async () => {
    const expectedBody = buildCanonicalPrBody({
      title: 'Workflow One',
      workflowSummary: 'Workflow summary.',
      structuredContext: {
        workflowName: 'Workflow One',
        workflowDescription: 'Workflow summary.',
        tasks: [{ taskId: 'wf-1/task-1', description: 'Run tests', status: 'completed', command: 'pnpm test' }],
        workerActions: [{
          id: 'wa-1',
          workerKind: 'ci-failure',
          actionType: 'fix-ci-failure',
          workflowId: 'wf-1',
          taskId: 'wf-1/task-1',
          subjectType: 'task',
          subjectId: 'wf-1/task-1',
          status: 'queued',
          summary: 'Queued CI repair',
          reason: 'failed-check',
          createdAt: '2026-01-01T00:01:00.000Z',
          updatedAt: '2026-01-01T00:01:00.000Z',
        }],
      },
    });
    const h = harness(expectedBody);

    await h.tick({ identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' }, reason: 'manual', tickNumber: 1 });

    expect(h.provider.updateReviewBody).not.toHaveBeenCalled();
    expect(h.writes.map((write) => write.status)).toEqual(['running', 'skipped']);
    expect(h.writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      summary: 'Skipped PR summary refresh: body already current',
    });
  });
});

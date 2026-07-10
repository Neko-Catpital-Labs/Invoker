import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  createPrSummaryRefreshTick,
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
    id: '__merge__wf-1',
    description: 'merge',
    status: 'review_ready',
    dependencies: ['task-1'],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', isMergeNode: true },
    execution: {
      workspacePath: '/repo/worktree',
      generation: 3,
      reviewGate: {
        activeGeneration: 3,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          title: 'Workflow A',
          url: 'https://github.com/owner/repo/pull/123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation: 3,
        }],
      },
    },
    taskStateVersion: 7,
  } as TaskState;
}

function makeWorkTask(): TaskState {
  return {
    id: 'task-1',
    description: 'Run focused tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: { branch: 'feature/task-1' },
    taskStateVersion: 2,
  } as TaskState;
}

function makeWorkerAction(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'ci-action',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'review',
    subjectId: '123',
    externalKey: 'ci-failure:__merge__wf-1:123',
    status: 'queued',
    attemptCount: 1,
    summary: 'Queued CI repair',
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:01:00.000Z',
    ...overrides,
  };
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = write.updatedAt ?? '2026-01-01T00:00:00.000Z';
  return {
    id: existing?.id ?? write.id,
    workerKind: write.workerKind,
    actionType: write.actionType,
    ...(write.workflowId ? { workflowId: write.workflowId } : {}),
    ...(write.taskId ? { taskId: write.taskId } : {}),
    subjectType: write.subjectType,
    subjectId: write.subjectId,
    externalKey: write.externalKey,
    status: write.status,
    attemptCount: write.attemptCount ?? existing?.attemptCount ?? 0,
    ...(write.intentId ? { intentId: write.intentId } : {}),
    ...(write.agentName ? { agentName: write.agentName } : {}),
    ...(write.executionModel ? { executionModel: write.executionModel } : {}),
    ...(write.sessionId ? { sessionId: write.sessionId } : {}),
    ...(write.summary ? { summary: write.summary } : {}),
    ...(write.payload !== undefined ? { payload: write.payload } : {}),
    createdAt: existing?.createdAt ?? write.createdAt ?? now,
    updatedAt: now,
    ...(write.completedAt ? { completedAt: write.completedAt } : {}),
  };
}

function makeHarness() {
  const tasks = [makeMergeTask(), makeWorkTask()];
  const actions = new Map<string, WorkerActionRecord>([
    ['ci-failure:ci-failure:__merge__wf-1:123', makeWorkerAction()],
  ]);
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const store = {
    listWorkflows: vi.fn(() => [{
      id: 'wf-1',
      name: 'Workflow A',
      description: 'Review lane visibility.',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    }]),
    loadTasks: vi.fn(() => tasks),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const saved = toRecord(write, actions.get(key));
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  const provider = {
    name: 'github',
    getReviewBody: vi.fn(async () => 'old body'),
    updateReviewBody: vi.fn(async () => undefined),
  };
  const tick = createPrSummaryRefreshTick({ store, provider, logger });
  return { actions, events, provider, store, tick };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical Pipeline content and records action state', async () => {
    const harness = makeHarness();

    await harness.tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
    });

    expect(harness.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = harness.provider.updateReviewBody.mock.calls[0][0].body as string;
    expect(body).toContain('## Pipeline');
    expect(body).toContain('ci-failure');
    expect(body).toContain('Queued CI repair');
    expect([...harness.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND))
      .toMatchObject({
        status: 'completed',
        summary: 'Updated PR summary with pipeline actions',
        attemptCount: 1,
      });
    expect(harness.events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        taskId: '__merge__wf-1',
        eventType: 'task.worker_action',
        payload: expect.objectContaining({
          workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
          actionType: 'refresh-pr-summary',
          status: 'completed',
        }),
      }),
    ]));
  });

  it('does not update the provider when the rendered body is unchanged', async () => {
    const harness = makeHarness();
    await harness.tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
    });
    const body = harness.provider.updateReviewBody.mock.calls[0][0].body as string;
    harness.provider.updateReviewBody.mockClear();
    harness.provider.getReviewBody.mockResolvedValue(body);

    await harness.tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 2,
    });

    expect(harness.provider.updateReviewBody).not.toHaveBeenCalled();
    expect([...harness.actions.values()].find((action) => action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND))
      .toMatchObject({
        status: 'skipped',
        summary: 'PR summary already up to date',
        payload: expect.objectContaining({ reason: 'unchanged' }),
      });
  });
});

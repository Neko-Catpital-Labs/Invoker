import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  PR_SUMMARY_REFRESH_WORKER_KIND,
  refreshPrSummaries,
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
    id: 'wf-1/task-a',
    description: 'Run tests',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function toRecord(write: WorkerActionWrite, existing?: WorkerActionRecord): WorkerActionRecord {
  const now = write.updatedAt ?? '2026-01-01T00:10:00.000Z';
  return {
    id: write.id,
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

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies, skips unchanged bodies, and records worker actions', async () => {
    const actions = new Map<string, WorkerActionRecord>();
    const writes: WorkerActionWrite[] = [];
    const taskEvents: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
    actions.set('autoapprove:autoapprove:wf-1/task-a', {
      id: 'autoapprove:wf-1/task-a',
      workerKind: 'autoapprove',
      actionType: 'approve-ai-fix',
      workflowId: 'wf-1',
      taskId: 'wf-1/task-a',
      subjectType: 'task',
      subjectId: 'wf-1/task-a',
      externalKey: 'autoapprove:wf-1/task-a',
      status: 'completed',
      attemptCount: 1,
      summary: 'Approved AI fix',
      payload: { reason: 'fix-session-complete' },
      createdAt: '2026-01-01T00:01:00.000Z',
      updatedAt: '2026-01-01T00:01:00.000Z',
      completedAt: '2026-01-01T00:01:00.000Z',
    });

    const mergeTask = makeTask({
      id: 'wf-1/__merge__',
      description: 'Merge',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge', summary: 'Merged work.' },
      execution: {
        workspacePath: '/tmp/repo',
        reviewGate: {
          activeGeneration: 0,
          completion: { required: 'all', status: 'approved' },
          artifacts: [{
            id: '42',
            title: 'Workflow A',
            url: 'https://github.com/owner/repo/pull/42',
            providerId: '42',
            provider: 'github',
            required: true,
            status: 'open',
            generation: 0,
          }],
        },
      },
    });

    const store = {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow A', description: 'Workflow description.' }]),
      loadTasks: vi.fn(() => [makeTask(), mergeTask]),
      listWorkerActions: vi.fn(() => [...actions.values()]),
      getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const key = `${write.workerKind}:${write.externalKey}`;
        const record = toRecord(write, actions.get(key));
        actions.set(key, record);
        writes.push(write);
        return record;
      }),
      logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
        taskEvents.push({ taskId, eventType, payload });
      }),
    };

    let liveBody = 'stale body';
    const provider: MergeGateProvider = {
      name: 'github',
      createReview: vi.fn() as never,
      checkApproval: vi.fn() as never,
      getReviewBody: vi.fn(async () => liveBody),
      updateReviewBody: vi.fn(async ({ body }) => {
        liveBody = body;
      }),
    };

    const first = await refreshPrSummaries({ store, logger, mergeGateProvider: provider });
    const second = await refreshPrSummaries({ store, logger, mergeGateProvider: provider });

    expect(first).toMatchObject({ scanned: 1, updated: 1, unchanged: 0, failed: 0 });
    expect(second).toMatchObject({ scanned: 1, updated: 0, unchanged: 1, failed: 0 });
    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(liveBody).toContain('## Pipeline');
    expect(liveBody).toContain('autoapprove/approve-ai-fix');
    expect(liveBody).toContain('Approved AI fix');
    expect(liveBody).not.toContain(`${PR_SUMMARY_REFRESH_WORKER_KIND}/refresh-pr-summary`);
    expect(writes.map((write) => write.status)).toEqual(expect.arrayContaining(['running', 'completed', 'skipped']));
    expect(taskEvents.some((event) =>
      event.taskId === 'wf-1/__merge__'
      && event.eventType === 'task.worker_action'
      && (event.payload as { workerKind?: string }).workerKind === PR_SUMMARY_REFRESH_WORKER_KIND,
    )).toBe(true);
  });
});

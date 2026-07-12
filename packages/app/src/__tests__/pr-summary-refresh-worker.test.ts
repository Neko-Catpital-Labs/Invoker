import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
} from '@invoker/execution-engine';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function task(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: 'wf-1/task-1',
    description: 'Implement feature',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function workerAction(overrides: Partial<WorkerActionRecord>): WorkerActionRecord {
  return {
    id: 'wa',
    workerKind: 'autofix',
    actionType: 'auto-fix',
    workflowId: 'wf-1',
    taskId: 'wf-1/task-1',
    subjectType: 'task',
    subjectId: 'wf-1/task-1',
    externalKey: 'autofix:wf-1/task-1',
    status: 'completed',
    attemptCount: 1,
    summary: 'Fixed task',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeStore(actions: WorkerActionRecord[]) {
  const writes: WorkerActionWrite[] = [];
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  return {
    writes,
    events,
    store: {
      listWorkflows: vi.fn(() => [{ id: 'wf-1', name: 'Workflow one', description: 'Refresh PR summaries.' }]),
      loadWorkflow: vi.fn(() => ({ id: 'wf-1', name: 'Workflow one', description: 'Refresh PR summaries.' })),
      loadTasks: vi.fn(() => [
        task(),
        task({
          id: '__merge__wf-1',
          description: 'Merge gate',
          status: 'review_ready',
          config: { workflowId: 'wf-1', isMergeNode: true },
          execution: {
            reviewId: '42',
            reviewUrl: 'https://github.com/org/repo/pull/42',
            workspacePath: '/repo',
          },
        }),
      ]),
      listWorkerActions: vi.fn(() => actions),
      getWorkerAction: vi.fn(() => undefined),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        writes.push(write);
        return {
          ...write,
          attemptCount: write.attemptCount ?? 0,
          createdAt: write.createdAt ?? write.updatedAt ?? '2026-01-01T00:00:00.000Z',
          updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
        } as WorkerActionRecord;
      }),
      logEvent: vi.fn((taskId: string, eventType: string, payload?: unknown) => {
        events.push({ taskId, eventType, payload });
      }),
    },
  };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical Pipeline rows in time order and records action state', async () => {
    const provider = {
      getReviewBody: vi.fn(async () => 'old body'),
      updateReviewBody: vi.fn(async () => {}),
    };
    const { store, writes, events } = makeStore([
      workerAction({
        id: 'late',
        workerKind: 'ci-failure',
        actionType: 'fix-ci-failure',
        summary: 'Queued CI repair',
        createdAt: '2026-01-01T00:02:00.000Z',
      }),
      workerAction({
        id: 'self',
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        actionType: 'refresh-pr-summary',
        summary: 'Previous refresh',
        createdAt: '2026-01-01T00:01:30.000Z',
      }),
      workerAction({
        id: 'early',
        workerKind: 'autofix',
        actionType: 'auto-fix',
        summary: 'Queued autofix',
        createdAt: '2026-01-01T00:01:00.000Z',
      }),
    ]);

    const tick = createPrSummaryRefreshTick({ store, provider, logger });
    await tick({
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual',
      tickNumber: 1,
      signal: new AbortController().signal,
    });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const body = provider.updateReviewBody.mock.calls[0]?.[0]?.body ?? '';
    expect(body).toContain('## Pipeline');
    expect(body.indexOf('autofix')).toBeLessThan(body.indexOf('ci-failure'));
    expect(body).not.toContain('Previous refresh');
    expect(writes[0]).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      workflowId: 'wf-1',
      taskId: '__merge__wf-1',
      subjectType: 'review',
      subjectId: '42',
      summary: 'Updated PR body with pipeline summary',
    });
    expect(events[0]).toMatchObject({
      taskId: '__merge__wf-1',
      eventType: 'task.worker_action',
      payload: expect.objectContaining({
        workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
        status: 'completed',
        reviewId: '42',
        bodyChanged: true,
      }),
    });
  });

  it('skips provider update when the live body is unchanged', async () => {
    let liveBody = 'old body';
    const provider = {
      getReviewBody: vi.fn(async () => liveBody),
      updateReviewBody: vi.fn(async (opts: { body: string }) => {
        liveBody = opts.body;
      }),
    };
    const { store, writes } = makeStore([
      workerAction({ id: 'early', summary: 'Queued autofix' }),
    ]);
    const tick = createPrSummaryRefreshTick({ store, provider, logger });
    const ctx = {
      identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
      reason: 'manual' as const,
      tickNumber: 1,
      signal: new AbortController().signal,
    };

    await tick(ctx);
    await tick({ ...ctx, tickNumber: 2 });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    expect(writes.at(-1)).toMatchObject({
      status: 'skipped',
      summary: 'PR body already has the current pipeline summary',
      payload: expect.objectContaining({ reason: 'up-to-date', bodyChanged: false }),
    });
  });
});

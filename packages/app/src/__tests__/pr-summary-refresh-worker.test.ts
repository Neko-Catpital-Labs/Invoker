import { describe, expect, it, vi } from 'vitest';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  buildPrSummaryRefreshBody,
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  type PrSummaryRefreshWorkflow,
} from '@invoker/execution-engine';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
};

const workflow: PrSummaryRefreshWorkflow = {
  id: 'wf-1',
  name: 'Visibility slice',
  description: 'Expose worker actions on PRs.',
};

function makeTask(overrides: Partial<TaskState>): TaskState {
  return {
    id: 'task-1',
    description: 'Task one',
    status: 'completed',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    taskStateVersion: 1,
    config: { workflowId: 'wf-1', command: 'pnpm test' },
    execution: {},
    ...overrides,
  } as TaskState;
}

function mergeTask(): TaskState {
  return makeTask({
    id: '__merge__wf-1',
    description: 'Merge workflow',
    status: 'review_ready',
    config: { workflowId: 'wf-1', isMergeNode: true, runnerKind: 'merge', summary: 'Merge summary' },
    execution: {
      workspacePath: '/tmp/repo',
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: '42',
          providerId: '42',
          provider: 'github',
          url: 'https://github.test/acme/repo/pull/42',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
  });
}

function action(overrides: Partial<WorkerActionRecord> = {}): WorkerActionRecord {
  return {
    id: 'ci-failure:1',
    workerKind: 'ci-failure',
    actionType: 'fix-ci-failure',
    workflowId: 'wf-1',
    taskId: '__merge__wf-1',
    subjectType: 'review',
    subjectId: '42',
    externalKey: 'ci:42',
    status: 'queued',
    attemptCount: 1,
    summary: 'Queued CI repair',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
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
    createdAt: write.createdAt ?? write.updatedAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
    completedAt: write.completedAt,
  };
}

function store(tasks: TaskState[], workerActions: WorkerActionRecord[] = [action()]) {
  const actions = new Map<string, WorkerActionRecord>();
  for (const row of workerActions) actions.set(`${row.workerKind}:${row.externalKey}`, row);
  return {
    listWorkflows: vi.fn(() => [workflow]),
    loadTasks: vi.fn(() => tasks),
    listWorkerActions: vi.fn(() => [...actions.values()]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const record = toRecord(write);
      actions.set(`${record.workerKind}:${record.externalKey}`, record);
      return record;
    }),
    logEvent: vi.fn(),
  };
}

describe('pr-summary-refresh worker', () => {
  it('updates changed PR bodies with canonical worker pipeline rows and records action state', async () => {
    const tasks = [makeTask({ id: 'task-1' }), mergeTask()];
    const s = store(tasks);
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => 'old body'),
      updateReviewBody: vi.fn(async () => {}),
    };

    await createPrSummaryRefreshTick({ store: s, provider, logger })({ reason: 'manual' });

    expect(provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const update = provider.updateReviewBody.mock.calls[0]?.[0];
    expect(update).toMatchObject({ identifier: '42', cwd: '/tmp/repo' });
    expect(update?.body).toContain('## Pipeline');
    expect(update?.body).toContain('ci-failure');
    expect(update?.body).toContain('Queued CI repair');
    expect(update?.body).not.toContain(PR_SUMMARY_REFRESH_WORKER_KIND);
    expect(s.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
      summary: 'Updated PR summary body',
    }));
    expect(s.logEvent).toHaveBeenCalledWith('__merge__wf-1', 'task.worker_action', expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: 'refresh-pr-summary',
      status: 'completed',
    }));
  });

  it('does not update the provider when the canonical body is already current', async () => {
    const tasks = [makeTask({ id: 'task-1' }), mergeTask()];
    const workerActions = [action()];
    const current = buildPrSummaryRefreshBody({ workflow, tasks, workerActions, mergeTask: tasks[1] });
    const s = store(tasks, workerActions);
    const provider = {
      name: 'github',
      getReviewBody: vi.fn(async () => `${current}\n`),
      updateReviewBody: vi.fn(async () => {}),
    };

    await createPrSummaryRefreshTick({ store: s, provider, logger })({ reason: 'manual' });

    expect(provider.updateReviewBody).not.toHaveBeenCalled();
    expect(s.upsertWorkerAction).toHaveBeenCalledWith(expect.objectContaining({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      summary: 'PR summary already current',
    }));
  });
});

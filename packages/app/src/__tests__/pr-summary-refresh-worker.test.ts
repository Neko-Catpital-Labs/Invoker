import { describe, expect, it, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import {
  createPrSummaryRefreshTick,
  PR_SUMMARY_REFRESH_WORKER_KIND,
  renderPrSummaryRefreshBody,
  type MergeGateProvider,
  type PrSummaryRefreshWorkerStore,
} from '@invoker/execution-engine';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function task(overrides: Partial<TaskState>): TaskState {
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
    createdAt: write.createdAt ?? '2026-01-01T00:00:00.000Z',
    updatedAt: write.updatedAt ?? '2026-01-01T00:00:00.000Z',
    completedAt: write.completedAt,
  };
}

function harness(existingBody: string) {
  const actions = new Map<string, WorkerActionRecord>();
  const writes: WorkerActionWrite[] = [];
  const events: Array<{ taskId: string; eventType: string; payload?: unknown }> = [];
  const workflow = { id: 'wf-1', name: 'Review workflow', description: 'Refreshes PR summaries.' };
  const tasks = [
    task({ id: 'wf-1/build', description: 'Build', config: { workflowId: 'wf-1', command: 'pnpm build' } as TaskState['config'] }),
    task({
      id: 'wf-1/__merge__',
      description: 'Review gate',
      status: 'review_ready',
      config: { workflowId: 'wf-1', isMergeNode: true } as TaskState['config'],
      execution: {
        reviewId: '123',
        reviewUrl: 'https://github.com/owner/repo/pull/123',
        workspacePath: '/repo',
      },
    }),
  ];
  const pipelineAction: WorkerActionRecord = {
    id: 'worker-action-1',
    workerKind: 'autofix',
    actionType: 'auto-fix',
    workflowId: 'wf-1',
    taskId: 'wf-1/build',
    subjectType: 'task',
    subjectId: 'wf-1/build',
    externalKey: 'autofix:wf-1/build',
    status: 'completed',
    attemptCount: 1,
    summary: 'Applied worker fix',
    payload: { reason: 'failed-test' },
    createdAt: '2026-01-01T00:01:00.000Z',
    updatedAt: '2026-01-01T00:02:00.000Z',
    completedAt: '2026-01-01T00:02:00.000Z',
  };
  const selfAction: WorkerActionRecord = {
    ...pipelineAction,
    id: 'self-action',
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'refresh-pr-summary',
    externalKey: 'self',
    summary: 'Previous refresh',
  };
  const store: PrSummaryRefreshWorkerStore = {
    listWorkflows: vi.fn(() => [workflow]),
    loadWorkflow: vi.fn(() => workflow),
    loadTasks: vi.fn(() => tasks),
    listWorkerActions: vi.fn(() => [selfAction, pipelineAction]),
    getWorkerAction: vi.fn((workerKind, externalKey) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write) => {
      writes.push(write);
      const saved = toRecord(write);
      actions.set(`${write.workerKind}:${write.externalKey}`, saved);
      return saved;
    }),
    logEvent: vi.fn((taskId, eventType, payload) => {
      events.push({ taskId, eventType, payload });
    }),
  };
  const provider: MergeGateProvider = {
    name: 'github',
    createReview: vi.fn(),
    checkApproval: vi.fn(),
    getReviewBody: vi.fn(async () => existingBody),
    updateReviewBody: vi.fn(async () => {}),
  };
  return { store, provider, writes, events, tasks, workflow };
}

async function runTick(store: PrSummaryRefreshWorkerStore, provider: MergeGateProvider): Promise<void> {
  const tick = createPrSummaryRefreshTick({ store, provider, logger });
  await tick({
    identity: { kind: PR_SUMMARY_REFRESH_WORKER_KIND, instanceId: 'test' },
    reason: 'manual',
    tickNumber: 1,
  });
}

describe('pr-summary-refresh worker', () => {
  it('updates PR bodies with Pipeline rows and records completed action state', async () => {
    const existingBody = [
      '## Summary',
      '',
      'Existing summary.',
      '',
      '## Test Plan',
      '',
      '- [x] old',
      '',
      '## Revert Plan',
      '',
      '- revert',
    ].join('\n');
    const h = harness(existingBody);

    await runTick(h.store, h.provider);

    expect(h.provider.updateReviewBody).toHaveBeenCalledTimes(1);
    const updatedBody = vi.mocked(h.provider.updateReviewBody!).mock.calls[0]?.[0].body ?? '';
    expect(updatedBody).toContain('## Pipeline');
    expect(updatedBody).toContain('autofix | auto-fix | completed');
    expect(updatedBody).not.toContain('Previous refresh');
    expect(h.writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'completed',
      summary: 'Refreshed PR summary',
    });
    expect(h.events.at(-1)).toMatchObject({
      taskId: 'wf-1/__merge__',
      eventType: 'task.worker_action',
    });
  });

  it('skips provider writes when the PR body is unchanged', async () => {
    const base = harness('');
    const existingBody = renderPrSummaryRefreshBody({
      existingBody: '',
      workflowTitle: base.workflow.name,
      workflowSummary: base.workflow.description,
      structuredContext: {
        workflowName: base.workflow.name,
        workflowDescription: base.workflow.description,
        tasks: [
          { taskId: 'wf-1/build', description: 'Build', status: 'completed', command: 'pnpm build' },
        ],
        workerActions: [{
          workerKind: 'autofix',
          actionType: 'auto-fix',
          status: 'completed',
          taskId: 'wf-1/build',
          summary: 'Applied worker fix',
          reason: 'failed-test',
          createdAt: '2026-01-01T00:01:00.000Z',
        }],
      },
    });
    const h = harness(existingBody);

    await runTick(h.store, h.provider);

    expect(h.provider.updateReviewBody).not.toHaveBeenCalled();
    expect(h.writes.at(-1)).toMatchObject({
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      status: 'skipped',
      summary: 'PR summary already current',
    });
  });
});

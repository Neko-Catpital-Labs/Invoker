import { describe, it, expect, vi } from 'vitest';
import type { TaskState, WorkflowDerivedStatus } from '@invoker/workflow-core';
import {
  planIdleTaskCleanup,
  createIdleTaskCleanupWorker,
  type IdleTaskCleanupWorkflowRow,
} from '../workers/idle-task-cleanup-worker.js';
import type { PrMaintenanceGitHub } from '../workers/pr-maintenance-github.js';

const NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const HOUR_MS = 60 * 60_000;
const RETENTION_MS = 48 * HOUR_MS;

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    id: overrides.id,
    description: overrides.description ?? 'task',
    status: overrides.status ?? 'completed',
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? new Date(NOW - 72 * HOUR_MS),
    config: { workflowId: 'wf-1', ...overrides.config },
    execution: { generation: 0, ...overrides.execution },
    taskStateVersion: 1,
  } as TaskState;
}

function makeWorkflow(
  id: string,
  overrides: Partial<IdleTaskCleanupWorkflowRow> = {},
): IdleTaskCleanupWorkflowRow {
  return {
    id,
    name: `workflow-${id}`,
    status: 'completed',
    createdAt: new Date(NOW - 72 * HOUR_MS).toISOString(),
    updatedAt: new Date(NOW - HOUR_MS).toISOString(),
    ...overrides,
  };
}

async function plan(
  workflows: IdleTaskCleanupWorkflowRow[],
  tasksByWorkflow: Record<string, TaskState[]>,
) {
  return planIdleTaskCleanup(workflows, (id) => tasksByWorkflow[id] ?? [], {
    now: NOW,
    retentionMs: RETENTION_MS,
  });
}

describe('planIdleTaskCleanup: workflow retirement', () => {
  it('prepares one delete-workflow action for a completed workflow without waiting 48 hours', async () => {
    const workflow = makeWorkflow('wf-completed', {
      status: 'completed',
      updatedAt: new Date(NOW - HOUR_MS).toISOString(),
    });
    const tasks = [
      makeTask({ id: 'wf-completed/one', status: 'completed' }),
      makeTask({ id: 'wf-completed/two', status: 'closed' }),
    ];

    const retirementActions = await plan([workflow], { 'wf-completed': tasks });

    expect(retirementActions).toEqual([
      {
        kind: 'delete-workflow',
        workflowId: 'wf-completed',
        reason: 'completed with no active tasks',
      },
    ]);
  });

  it('prepares one delete-workflow action for an inactive workflow strictly older than 48 hours', async () => {
    const workflow = makeWorkflow('wf-old-failed', {
      status: 'failed',
      updatedAt: new Date(NOW - RETENTION_MS - 1).toISOString(),
    });
    const tasks = [
      makeTask({ id: 'wf-old-failed/failed', status: 'failed' }),
      makeTask({ id: 'wf-old-failed/stale', status: 'stale' }),
    ];

    const retirementActions = await plan([workflow], { 'wf-old-failed': tasks });

    expect(retirementActions).toEqual([
      {
        kind: 'delete-workflow',
        workflowId: 'wf-old-failed',
        reason: 'inactive for more than 48 hours',
      },
    ]);
  });

  it('retains an inactive workflow at exactly 48 hours and retires it one millisecond later', async () => {
    const atBoundary = makeWorkflow('wf-boundary', {
      status: 'failed',
      updatedAt: new Date(NOW - RETENTION_MS).toISOString(),
    });
    const pastBoundary = makeWorkflow('wf-past-boundary', {
      status: 'failed',
      updatedAt: new Date(NOW - RETENTION_MS - 1).toISOString(),
    });
    const tasksByWorkflow = {
      'wf-boundary': [makeTask({ id: 'wf-boundary/task', status: 'failed' })],
      'wf-past-boundary': [makeTask({ id: 'wf-past-boundary/task', status: 'failed' })],
    };

    const retirementActions = await plan([atBoundary, pastBoundary], tasksByWorkflow);

    expect(retirementActions.map((action) => action.workflowId)).toEqual(['wf-past-boundary']);
  });

  it.each([
    'pending',
    'queued',
    'running',
    'fixing_with_ai',
    'needs_input',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ] as const)('retains a completed or old workflow with a %s task', async (status) => {
    const completed = makeWorkflow(`wf-completed-${status}`, {
      status: 'completed',
      updatedAt: new Date(NOW - RETENTION_MS - HOUR_MS).toISOString(),
    });
    const old = makeWorkflow(`wf-old-${status}`, {
      status: 'failed',
      updatedAt: new Date(NOW - RETENTION_MS - HOUR_MS).toISOString(),
    });

    const retirementActions = await plan([completed, old], {
      [completed.id]: [makeTask({ id: `${completed.id}/task`, status })],
      [old.id]: [makeTask({ id: `${old.id}/task`, status })],
    });

    expect(retirementActions).toEqual([]);
  });

  it('retains unknown workflow and task statuses regardless of age', async () => {
    const unknownWorkflow = makeWorkflow('wf-unknown-workflow', {
      status: 'new-future-status' as WorkflowDerivedStatus,
      updatedAt: new Date(NOW - RETENTION_MS - HOUR_MS).toISOString(),
    });
    const unknownTaskWorkflow = makeWorkflow('wf-unknown-task', {
      status: 'completed',
      updatedAt: new Date(NOW - RETENTION_MS - HOUR_MS).toISOString(),
    });

    const retirementActions = await plan([unknownWorkflow, unknownTaskWorkflow], {
      'wf-unknown-workflow': [makeTask({ id: 'wf-unknown-workflow/task', status: 'completed' })],
      'wf-unknown-task': [
        makeTask({ id: 'wf-unknown-task/task', status: 'new-future-status' as TaskState['status'] }),
      ],
    });

    expect(retirementActions).toEqual([]);
  });

  it('uses updatedAt as canonical activity and retains invalid timestamps', async () => {
    const recentlyUpdated = makeWorkflow('wf-recently-updated', {
      status: 'failed',
      createdAt: new Date(NOW - 90 * 24 * HOUR_MS).toISOString(),
      updatedAt: new Date(NOW - HOUR_MS).toISOString(),
    });
    const invalidActivity = makeWorkflow('wf-invalid-activity', {
      status: 'failed',
      createdAt: new Date(NOW - 90 * 24 * HOUR_MS).toISOString(),
      updatedAt: 'not-a-date',
    });

    const retirementActions = await plan([recentlyUpdated, invalidActivity], {
      'wf-recently-updated': [makeTask({ id: 'wf-recently-updated/task', status: 'failed' })],
      'wf-invalid-activity': [makeTask({ id: 'wf-invalid-activity/task', status: 'failed' })],
    });

    expect(retirementActions).toEqual([]);
  });

  it('does not put task, PR, or branch mutation fields in a retirement action', async () => {
    const workflow = makeWorkflow('wf-shape');
    const [action] = await plan([workflow], {
      'wf-shape': [
        makeTask({
          id: 'wf-shape/task',
          status: 'completed',
          execution: { reviewId: '4242', branch: 'feature/do-not-delete' },
        }),
      ],
    });

    expect(action).toEqual(expect.objectContaining({ kind: 'delete-workflow', workflowId: 'wf-shape' }));
    expect(action).not.toHaveProperty('taskId');
    expect(action).not.toHaveProperty('prNumber');
    expect(action).not.toHaveProperty('deleteBranch');
  });
});

describe('createIdleTaskCleanupWorker: live workflow retirement', () => {
  function makeGithub(): PrMaintenanceGitHub {
    return {
      listOpenPullRequests: vi.fn(async () => []),
      viewPullRequest: vi.fn(async () => ({ state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' })),
      fetchCoderabbitComments: vi.fn(async () => []),
      postPullRequestComment: vi.fn(async () => true),
      closePullRequest: vi.fn(async () => true),
    };
  }

  it('submits a workflow retirement without calling GitHub or submitting a task mutation', async () => {
    const github = makeGithub();
    const submit = vi.fn(() => 1);
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(function (this: unknown) { return this; }),
    } as any;
    const workflow = makeWorkflow('wf-completed');
    const task = makeTask({ id: 'wf-completed/task', status: 'completed' });

    const worker = createIdleTaskCleanupWorker({
      logger,
      store: {
        listWorkflows: () => [workflow],
        loadTasks: (id) => (id === workflow.id ? [task] : []),
        logEvent: vi.fn(),
      },
      submitter: { submit },
      github,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(github.viewPullRequest).not.toHaveBeenCalled();
    expect(github.closePullRequest).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      'wf-completed',
      'high',
      'invoker:delete-workflow',
      ['wf-completed'],
    );
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('submitted workflow retirement for wf-completed'),
      expect.objectContaining({ workflowId: 'wf-completed', intentId: 1 }),
    );
  });
});

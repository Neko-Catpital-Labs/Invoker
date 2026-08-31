import { describe, expect, it, vi } from 'vitest';
import type { TaskState, TaskStatus } from '@invoker/workflow-core';

import {
  createIdleTaskCleanupWorker,
  planIdleTaskCleanup,
  type IdleTaskCleanupWorkflowRow,
} from '../workers/idle-task-cleanup-worker.js';
import { WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS } from '../workers/idle-task-cleanup-policy.js';
import type { PrMaintenanceGitHub } from '../workers/pr-maintenance-github.js';

const NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const OVER_48_HOURS_AGO = new Date(NOW - WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS - 1).toISOString();

function makeWorkflow(
  id: string,
  status: string,
  updatedAt: string = new Date(NOW).toISOString(),
): IdleTaskCleanupWorkflowRow {
  return { id, name: id, status, updatedAt };
}

function makeTask(id: string, status: TaskStatus): TaskState {
  return {
    id,
    description: id,
    status,
    dependencies: [],
    createdAt: new Date(NOW - 60 * 60_000),
    config: { workflowId: id.split('/')[0] },
    execution: { generation: 0 },
    taskStateVersion: 1,
  } as TaskState;
}

function plan(
  workflows: IdleTaskCleanupWorkflowRow[],
  tasksByWorkflow: Record<string, TaskState[]>,
) {
  return planIdleTaskCleanup(workflows, (id) => tasksByWorkflow[id] ?? [], { now: NOW });
}

describe('planIdleTaskCleanup', () => {
  it('plans one workflow retirement for a completed workflow with no active tasks', () => {
    const workflow = makeWorkflow('wf-completed', 'completed');
    const tasks = [
      makeTask('wf-completed/task-1', 'completed'),
      makeTask('wf-completed/task-2', 'closed'),
      makeTask('wf-completed/task-3', 'stale'),
    ];

    expect(plan([workflow], { 'wf-completed': tasks })).toEqual([
      { kind: 'delete-workflow', workflowId: 'wf-completed', reason: 'workflow completed' },
    ]);
  });

  it('plans one workflow retirement, not one action per task, when inactive beyond 48 hours', () => {
    const workflow = makeWorkflow('wf-old', 'failed', OVER_48_HOURS_AGO);
    const tasks = [
      makeTask('wf-old/task-1', 'failed'),
      makeTask('wf-old/task-2', 'closed'),
      makeTask('wf-old/task-3', 'completed'),
    ];

    expect(plan([workflow], { 'wf-old': tasks })).toEqual([
      {
        kind: 'delete-workflow',
        workflowId: 'wf-old',
        reason: 'workflow inactive beyond retirement threshold',
      },
    ]);
  });

  it('retains a non-completed workflow at exactly 48 hours', () => {
    const workflow = makeWorkflow(
      'wf-boundary',
      'failed',
      new Date(NOW - WORKFLOW_RETIREMENT_IDLE_THRESHOLD_MS).toISOString(),
    );

    expect(plan([workflow], { 'wf-boundary': [makeTask('wf-boundary/task', 'failed')] })).toEqual([]);
  });

  it('retains a fresh non-completed workflow', () => {
    const workflow = makeWorkflow('wf-fresh', 'failed');

    expect(plan([workflow], { 'wf-fresh': [makeTask('wf-fresh/task', 'failed')] })).toEqual([]);
  });

  it.each<TaskStatus>([
    'pending',
    'queued',
    'running',
    'fixing_with_ai',
    'needs_input',
    'blocked',
    'review_ready',
    'awaiting_approval',
  ])('retains an old workflow while a task is %s', (status) => {
    const workflow = makeWorkflow(`wf-active-${status}`, 'failed', OVER_48_HOURS_AGO);

    expect(plan([workflow], {
      [workflow.id]: [makeTask(`${workflow.id}/task`, status)],
    })).toEqual([]);
  });

  it('retains a completed workflow when its task state is active', () => {
    const workflow = makeWorkflow('wf-completed-active', 'completed', OVER_48_HOURS_AGO);

    expect(plan([workflow], {
      [workflow.id]: [makeTask(`${workflow.id}/task`, 'running')],
    })).toEqual([]);
  });

  it('retains unknown workflow and task states', () => {
    const unknownWorkflow = makeWorkflow('wf-unknown-workflow', 'future_workflow_state', OVER_48_HOURS_AGO);
    const unknownTaskWorkflow = makeWorkflow('wf-unknown-task', 'failed', OVER_48_HOURS_AGO);
    const unknownTask = {
      ...makeTask('wf-unknown-task/task', 'failed'),
      status: 'future_task_state',
    } as unknown as TaskState;

    expect(plan([unknownWorkflow, unknownTaskWorkflow], {
      'wf-unknown-workflow': [makeTask('wf-unknown-workflow/task', 'failed')],
      'wf-unknown-task': [unknownTask],
    })).toEqual([]);
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
    const workflow = makeWorkflow('wf-completed', 'completed');

    const worker = createIdleTaskCleanupWorker({
      logger,
      store: {
        listWorkflows: () => [workflow],
        loadTasks: () => [makeTask('wf-completed/task', 'completed')],
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

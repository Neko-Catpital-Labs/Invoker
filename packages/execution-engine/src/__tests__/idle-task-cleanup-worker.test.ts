import { describe, it, expect, vi } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import {
  planIdleTaskCleanup,
  createIdleTaskCleanupWorker,
  type IdleTaskCleanupWorkflowRow,
} from '../workers/idle-task-cleanup-worker.js';
import type { PrMaintenanceGitHub } from '../workers/pr-maintenance-github.js';

const NOW = new Date('2026-08-15T12:00:00.000Z').getTime();
const IDLE_15M = 15 * 60_000;

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    id: overrides.id,
    description: overrides.description ?? 'task',
    status: overrides.status ?? 'pending',
    dependencies: overrides.dependencies ?? [],
    createdAt: overrides.createdAt ?? new Date(NOW - 60 * 60_000),
    config: { workflowId: 'wf-1', ...overrides.config },
    execution: { generation: 0, ...overrides.execution },
    taskStateVersion: 1,
  } as TaskState;
}

const adminBypassWorkflow: IdleTaskCleanupWorkflowRow = {
  id: 'wf-admin',
  name: 'repair-pr-801-ab12cd34ef56ab12',
  description: 'repair admin-bypass PR #801',
};

const e2eWorkflow: IdleTaskCleanupWorkflowRow = {
  id: 'wf-e2e',
  name: 'CI regression: abc123-unit',
  description: 'invoker-ci-regression-watch: first-bad-sha=abc123; job=unit',
};

const unrelatedWorkflow: IdleTaskCleanupWorkflowRow = {
  id: 'wf-other',
  name: 'my-feature-workflow',
  description: 'just a normal feature',
};

async function plan(
  workflows: IdleTaskCleanupWorkflowRow[],
  tasksByWorkflow: Record<string, TaskState[]>,
  overrides: { isPullRequestMerged?: (prNumber: number) => Promise<boolean>; idleThresholdMs?: number } = {},
) {
  return planIdleTaskCleanup(workflows, (id) => tasksByWorkflow[id] ?? [], {
    now: NOW,
    idleThresholdMs: overrides.idleThresholdMs ?? IDLE_15M,
    isPullRequestMerged: overrides.isPullRequestMerged ?? (async () => false),
  });
}

describe('planIdleTaskCleanup: scope', () => {
  it('ignores workflows that match neither the admin-bypass-repair nor e2e-repair family', async () => {
    const task = makeTask({ id: 'wf-other/task', status: 'failed', execution: { completedAt: new Date(NOW - IDLE_15M) } });
    const actions = await plan([unrelatedWorkflow], { 'wf-other': [task] });
    expect(actions).toEqual([]);
  });

  it('ignores non-closable statuses even in an eligible workflow', async () => {
    const task = makeTask({ id: 'wf-admin/task', status: 'running', execution: { completedAt: new Date(NOW - IDLE_15M) } });
    const actions = await plan([adminBypassWorkflow], { 'wf-admin': [task] });
    expect(actions).toEqual([]);
  });
});

describe('planIdleTaskCleanup: idle threshold', () => {
  it('does not act just under 15 minutes idle', async () => {
    const task = makeTask({
      id: 'wf-admin/task',
      status: 'failed',
      execution: { completedAt: new Date(NOW - (IDLE_15M - 1000)) },
    });
    const actions = await plan([adminBypassWorkflow], { 'wf-admin': [task] });
    expect(actions).toEqual([]);
  });

  it('acts once idle reaches exactly 15 minutes', async () => {
    const task = makeTask({
      id: 'wf-admin/task',
      status: 'failed',
      execution: { completedAt: new Date(NOW - IDLE_15M) },
    });
    const actions = await plan([adminBypassWorkflow], { 'wf-admin': [task] });
    expect(actions).toHaveLength(1);
  });

  it('skips a task with no completedAt (never actually terminal)', async () => {
    const task = makeTask({ id: 'wf-admin/task', status: 'failed' });
    const actions = await plan([adminBypassWorkflow], { 'wf-admin': [task] });
    expect(actions).toEqual([]);
  });
});

describe('planIdleTaskCleanup: status branching', () => {
  it('failed in an admin-bypass-repair workflow: unconditional close-task-and-pr, PR from workflow name', async () => {
    const task = makeTask({ id: 'wf-admin/task', status: 'failed', execution: { completedAt: new Date(NOW - IDLE_15M) } });
    const actions = await plan([adminBypassWorkflow], { 'wf-admin': [task] });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'close-task-and-pr', taskId: 'wf-admin/task', prNumber: 801, deleteBranch: true }),
    ]);
  });

  it('review_ready in an e2e-repair workflow: unconditional close-task-and-pr, PR from execution.reviewId', async () => {
    const mergeTask = makeTask({
      id: '__merge__wf-e2e',
      status: 'review_ready',
      execution: { completedAt: new Date(NOW - IDLE_15M), reviewId: '4242' },
    });
    const actions = await plan([e2eWorkflow], { 'wf-e2e': [mergeTask] });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'close-task-and-pr', taskId: '__merge__wf-e2e', prNumber: 4242, deleteBranch: true }),
    ]);
  });

  it('failed/review_ready with no resolvable PR: close-task-only', async () => {
    const task = makeTask({
      id: 'wf-e2e/fix-ci-abc',
      status: 'failed',
      execution: { completedAt: new Date(NOW - IDLE_15M) }, // no reviewId: not the merge node
    });
    const actions = await plan([e2eWorkflow], { 'wf-e2e': [task] });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'close-task-only', taskId: 'wf-e2e/fix-ci-abc' }),
    ]);
  });

  it('completed with an already-merged PR: close-task-and-pr', async () => {
    const mergeTask = makeTask({
      id: '__merge__wf-e2e',
      status: 'completed',
      execution: { completedAt: new Date(NOW - IDLE_15M), reviewId: '4242' },
    });
    const actions = await plan([e2eWorkflow], { 'wf-e2e': [mergeTask] }, { isPullRequestMerged: async () => true });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'close-task-and-pr', taskId: '__merge__wf-e2e', prNumber: 4242, deleteBranch: true }),
    ]);
  });

  it('completed with a not-yet-merged PR: close-task-only, PR/branch untouched', async () => {
    const mergeTask = makeTask({
      id: '__merge__wf-e2e',
      status: 'completed',
      execution: { completedAt: new Date(NOW - IDLE_15M), reviewId: '4242' },
    });
    const actions = await plan([e2eWorkflow], { 'wf-e2e': [mergeTask] }, { isPullRequestMerged: async () => false });
    expect(actions).toEqual([
      expect.objectContaining({ kind: 'close-task-only', taskId: '__merge__wf-e2e' }),
    ]);
  });
});

describe('createIdleTaskCleanupWorker: dry-run', () => {
  function makeGithub(): PrMaintenanceGitHub {
    return {
      listOpenPullRequests: vi.fn(async () => []),
      viewPullRequest: vi.fn(async () => ({ state: 'MERGED', mergedAt: '2026-08-01T00:00:00Z' })),
      fetchCoderabbitComments: vi.fn(async () => []),
      postPullRequestComment: vi.fn(async () => true),
      closePullRequest: vi.fn(async () => true),
    };
  }

  it('never calls closePullRequest or submit — dry-run only logs', async () => {
    const github = makeGithub();
    const submit = vi.fn(() => 1);
    const logger = {
      debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
      child: vi.fn(function (this: unknown) { return this; }),
    } as any;
    const task = makeTask({ id: 'wf-admin/task', status: 'failed', execution: { completedAt: new Date(NOW - IDLE_15M) } });

    const worker = createIdleTaskCleanupWorker({
      logger,
      store: {
        listWorkflows: () => [adminBypassWorkflow],
        loadTasks: (id) => (id === 'wf-admin' ? [task] : []),
        logEvent: vi.fn(),
      },
      submitter: { submit },
      github,
      now: () => NOW,
      tickOnStart: false,
      intervalMs: 0,
    });

    await worker.tick('manual');

    expect(github.closePullRequest).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('(dry-run) would close task + PR #801'),
      expect.objectContaining({ taskId: 'wf-admin/task' }),
    );
  });
});

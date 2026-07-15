import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SQLiteAdapter, SqliteTaskRepository } from '@invoker/data-store';
import type { Workflow } from '@invoker/data-store';
import { Orchestrator } from '@invoker/workflow-core';
import type { OrchestratorMessageBus, TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';
import type { MergeGateProvider, MergeGateApprovalStatus } from '../merge-gate-provider.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
}

const WORKFLOW: Workflow = {
  id: 'wf-heartbeat',
  name: 'Review gate heartbeat proof',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function reviewGateTask(id: string, reviewId: string, status: TaskState['status']): TaskState {
  return {
    id,
    description: 'Review gate for Sidebar manual control',
    status,
    dependencies: [],
    createdAt: new Date('2026-07-08T06:00:00.000Z'),
    config: { workflowId: WORKFLOW.id, isMergeNode: true },
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      reviewId,
      workspacePath: '/workspace/heartbeat-gate',
      lastHeartbeatAt: new Date('2026-07-08T06:59:05.000Z'),
      heartbeatSource: 'executor',
    },
  } as TaskState;
}
function structuredReviewGateTask(id: string, reviewId: string, status: TaskState['status']): TaskState {
  return {
    ...reviewGateTask(id, reviewId, status),
    execution: {
      ...reviewGateTask(id, reviewId, status).execution,
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: reviewId,
          providerId: reviewId,
          provider: 'stub-github',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
  } as TaskState;
}


function stubMergeGateProvider(overrides: Partial<MergeGateApprovalStatus> = {}): MergeGateProvider {
  return {
    name: 'stub-github',
    createReview: vi.fn(async () => ({ url: 'https://github.com/foo/bar/pull/301', identifier: 'foo/bar#301' })),
    checkApproval: vi.fn(async (): Promise<MergeGateApprovalStatus> => ({
      lifecycle: 'open',
      rejected: false,
      statusText: 'Pending review',
      url: 'https://github.com/foo/bar/pull/301',
      ...overrides,
    })),
  };
}

describe('pollMergeGateTask → SQLite heartbeat persistence', () => {
  let adapter: SQLiteAdapter;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(WORKFLOW);
    orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus: new NoopBus(),
      taskRepository: new SqliteTaskRepository(adapter),
      maxConcurrency: 3,
    });
  });

  afterEach(() => {
    adapter.close();
  });

  it('checkMergeGateStatuses advances lastHeartbeatAt for an awaiting_approval task in SQLite', async () => {
    const before = new Date('2026-07-08T06:59:05.000Z');
    const task = reviewGateTask('merge-heartbeat', 'foo/bar#301', 'awaiting_approval');
    adapter.saveTask(WORKFLOW.id, task);
    orchestrator.syncFromDb(WORKFLOW.id);

    const seeded = adapter.loadTasks(WORKFLOW.id).find((t) => t.id === task.id)!;
    expect(seeded.status).toBe('awaiting_approval');
    expect(seeded.execution.lastHeartbeatAt?.toISOString()).toBe(before.toISOString());

    const runner = new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: stubMergeGateProvider(),
    });

    const beforePoll = Date.now();
    await runner.checkMergeGateStatuses();
    const afterPoll = Date.now();

    const persisted = adapter.loadTasks(WORKFLOW.id).find((t) => t.id === task.id)!;
    const heartbeat = persisted.execution.lastHeartbeatAt;
    expect(heartbeat).toBeInstanceOf(Date);
    const heartbeatMs = (heartbeat as Date).getTime();
    expect(heartbeatMs).toBeGreaterThanOrEqual(beforePoll);
    expect(heartbeatMs).toBeLessThanOrEqual(afterPoll);
    expect(heartbeatMs).toBeGreaterThan(before.getTime());
  });
  it('persists checksState failedChecks and mergeState onto an open review artifact', async () => {
    const task = structuredReviewGateTask('merge-health', 'foo/bar#303', 'review_ready');
    adapter.saveTask(WORKFLOW.id, task);
    orchestrator.syncFromDb(WORKFLOW.id);

    const runner = new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: stubMergeGateProvider({
        statusText: 'Checks failing',
        mergeState: 'dirty',
        checks: {
          state: 'failure',
          failed: [{ name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/lint' }],
        },
      }),
    });

    await runner.checkMergeGateStatuses();

    const persisted = adapter.loadTasks(WORKFLOW.id).find((candidate) => candidate.id === task.id)!;
    expect(persisted.execution.reviewGate?.artifacts).toEqual([
      expect.objectContaining({
        id: 'foo/bar#303',
        status: 'open',
        rawStatus: 'Checks failing',
        checksState: 'failure',
        failedChecks: [{ name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/lint' }],
        mergeState: 'dirty',
      }),
    ]);
  });

  it('checkPrApprovalNow advances lastHeartbeatAt for a review_ready task in SQLite', async () => {
    const before = new Date('2026-07-08T06:59:05.000Z');
    const task = reviewGateTask('manual-heartbeat', 'foo/bar#302', 'review_ready');
    adapter.saveTask(WORKFLOW.id, task);
    orchestrator.syncFromDb(WORKFLOW.id);

    const runner = new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: stubMergeGateProvider(),
    });

    const beforePoll = Date.now();
    await runner.checkPrApprovalNow(task.id);
    const afterPoll = Date.now();

    const persisted = adapter.loadTasks(WORKFLOW.id).find((t) => t.id === task.id)!;
    const heartbeat = persisted.execution.lastHeartbeatAt;
    expect(heartbeat).toBeInstanceOf(Date);
    const heartbeatMs = (heartbeat as Date).getTime();
    expect(heartbeatMs).toBeGreaterThanOrEqual(beforePoll);
    expect(heartbeatMs).toBeLessThanOrEqual(afterPoll);
    expect(heartbeatMs).toBeGreaterThan(before.getTime());
  });

  it('does not touch lastHeartbeatAt when the task has no required review artifacts (nothing to poll)', async () => {
    const before = new Date('2026-07-08T06:59:05.000Z');
    const task: TaskState = {
      ...reviewGateTask('no-artifacts', 'unused', 'awaiting_approval'),
      execution: {
        generation: 1,
        selectedAttemptId: 'attempt-1',
        workspacePath: '/workspace/heartbeat-gate',
        lastHeartbeatAt: before,
        heartbeatSource: 'executor',
      },
    } as TaskState;
    adapter.saveTask(WORKFLOW.id, task);
    orchestrator.syncFromDb(WORKFLOW.id);

    const runner = new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: stubMergeGateProvider(),
    });

    await runner.checkMergeGateStatuses();

    const persisted = adapter.loadTasks(WORKFLOW.id).find((t) => t.id === task.id)!;
    expect(persisted.execution.lastHeartbeatAt?.toISOString()).toBe(before.toISOString());
  });
});

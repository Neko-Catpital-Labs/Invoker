import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter, SqliteTaskRepository, type Workflow } from '@invoker/data-store';
import { Orchestrator, type OrchestratorMessageBus, type TaskState } from '@invoker/workflow-core';
import { TaskRunner } from '../task-runner.js';
import type { MergeGateApprovalStatus, MergeGateProvider } from '../merge-gate-provider.js';
import type { ReviewGateMergeConflictTrigger } from '../task-runner-review-gate.js';

class NoopBus implements OrchestratorMessageBus {
  publish(): void {}
}

const WORKFLOW: Workflow = {
  id: 'wf-merge-conflict-publisher',
  name: 'Review gate merge conflict publisher proof',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const REVIEW_ID = 'owner/repo#412';
const REVIEW_URL = 'https://github.com/owner/repo/pull/412';
const HEAD_SHA = 'abc123conflict';
const HEAD_REF = 'feature/conflict';
const SELECTED_ATTEMPT_ID = 'attempt-merge-conflict-1';
const WORKSPACE_PATH = '/workspace/merge-conflict-gate';

function mergeNodeTask(id: string = 'merge-conflict-gate'): TaskState {
  return {
    id,
    description: 'Review gate for merge conflict publisher',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-07-20T00:00:00.000Z'),
    config: { workflowId: WORKFLOW.id, isMergeNode: true },
    execution: {
      generation: 1,
      selectedAttemptId: SELECTED_ATTEMPT_ID,
      reviewId: REVIEW_ID,
      branch: 'invoker/merge-conflict-gate',
      workspacePath: WORKSPACE_PATH,
      reviewGate: {
        activeGeneration: 1,
        completion: { required: 'all', status: 'approved' },
        artifacts: [{
          id: REVIEW_ID,
          providerId: REVIEW_ID,
          provider: 'stub-github',
          required: true,
          status: 'open',
          generation: 1,
        }],
      },
    },
    taskStateVersion: 7,
  };
}

function approvalStatus(overrides: Partial<MergeGateApprovalStatus> = {}): MergeGateApprovalStatus {
  return {
    lifecycle: 'open',
    rejected: false,
    statusText: 'Merge blocked by conflicts',
    url: REVIEW_URL,
    headSha: HEAD_SHA,
    headRef: HEAD_REF,
    mergeState: 'dirty',
    hasMergeConflict: true,
    ...overrides,
  };
}

function stubMergeGateProvider(status: MergeGateApprovalStatus): MergeGateProvider {
  return {
    name: 'stub-github',
    createReview: vi.fn(async () => ({ url: REVIEW_URL, identifier: REVIEW_ID })),
    checkApproval: vi.fn(async () => status),
  };
}

describe('review-gate merge-conflict lifecycle publisher', () => {
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

  function saveAndSync(task: TaskState = mergeNodeTask()): TaskState {
    adapter.saveTask(WORKFLOW.id, task);
    orchestrator.syncFromDb(WORKFLOW.id);
    return task;
  }

  function createRunner(
    provider: MergeGateProvider,
    published: ReviewGateMergeConflictTrigger[] = [],
  ): TaskRunner {
    return new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: provider,
      reviewGateMergeConflictPublisher: {
        publish: (trigger) => {
          published.push(trigger);
        },
      },
    });
  }

  it('publishes one merge-conflict trigger for a dirty conflicted review gate', async () => {
    const task = saveAndSync();
    const published: ReviewGateMergeConflictTrigger[] = [];
    const runner = createRunner(stubMergeGateProvider(approvalStatus()), published);

    await runner.checkMergeGateStatuses();

    expect(published).toHaveLength(1);
    expect(published[0]).toMatchObject({
      taskId: task.id,
      workflowId: WORKFLOW.id,
      reviewId: REVIEW_ID,
      reviewUrl: REVIEW_URL,
      headSha: HEAD_SHA,
      generation: 1,
      selectedAttemptId: SELECTED_ATTEMPT_ID,
    });
  });

  it('persists dirty mergeState onto the polled review artifact', async () => {
    const task = saveAndSync();
    const runner = createRunner(stubMergeGateProvider(approvalStatus()));

    await runner.checkMergeGateStatuses();

    const persisted = adapter.loadTasks(WORKFLOW.id).find((candidate) => candidate.id === task.id)!;
    expect(persisted.execution.reviewGate?.artifacts[0]?.mergeState).toBe('dirty');
  });

  it('does not publish when the provider reports a clean merge state', async () => {
    saveAndSync();
    const published: ReviewGateMergeConflictTrigger[] = [];
    const runner = createRunner(stubMergeGateProvider(approvalStatus({
      statusText: 'Ready to merge',
      mergeState: 'clean',
      hasMergeConflict: false,
    })), published);

    await runner.checkMergeGateStatuses();

    expect(published).toHaveLength(0);
  });

  it('publishes again on a later poll for the same conflict', async () => {
    saveAndSync();
    const published: ReviewGateMergeConflictTrigger[] = [];
    const runner = createRunner(stubMergeGateProvider(approvalStatus()), published);

    await runner.checkMergeGateStatuses();
    await runner.checkMergeGateStatuses();

    // The producer only collapses concurrent in-flight publishes; durable
    // per-conflict deduplication belongs to the worker action key.
    expect(published).toHaveLength(2);
  });
});

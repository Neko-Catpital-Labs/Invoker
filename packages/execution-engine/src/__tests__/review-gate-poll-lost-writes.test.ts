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
  id: 'wf-lost-writes',
  name: 'Review gate lost writes proof',
  status: 'running',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const TASK_ID = 'merge-lost-writes';
const PROVIDER_IDS = Array.from({ length: 9 }, (_, index) => `foo/bar#${401 + index}`);

function nineArtifactGateTask(): TaskState {
  return {
    id: TASK_ID,
    description: 'Review gate for a nine-PR stack',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-07-08T06:00:00.000Z'),
    config: { workflowId: WORKFLOW.id, isMergeNode: true },
    execution: {
      generation: 1,
      selectedAttemptId: 'attempt-1',
      workspacePath: '/workspace/lost-writes-gate',
      reviewGate: {
        activeGeneration: 8,
        completion: { required: 'all', status: 'pending' },
        artifacts: PROVIDER_IDS.map((providerId) => ({
          id: providerId,
          providerId,
          provider: 'stub-github',
          required: true,
          status: 'open',
          generation: 8,
        })),
      },
    },
  } as TaskState;
}

function stubMergeGateProvider(openProviderIds: ReadonlySet<string>): MergeGateProvider {
  return {
    name: 'stub-github',
    createReview: vi.fn(async () => ({ url: 'https://github.com/foo/bar/pull/401', identifier: 'foo/bar#401' })),
    checkApproval: vi.fn(async ({ identifier }: { identifier: string }): Promise<MergeGateApprovalStatus> => {
      const open = openProviderIds.has(identifier);
      return {
        lifecycle: open ? 'open' : 'merged',
        rejected: false,
        statusText: open ? 'Pending review' : 'Merged',
        url: `https://github.com/foo/bar/pull/${identifier.split('#')[1]}`,
      };
    }),
  };
}

describe('pollMergeGateTask → review-gate artifact saves across one poll round', () => {
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
    adapter.saveTask(WORKFLOW.id, nineArtifactGateTask());
    orchestrator.syncFromDb(WORKFLOW.id);
  });

  afterEach(() => {
    adapter.close();
  });

  function createRunner(openProviderIds: ReadonlySet<string>): TaskRunner {
    return new TaskRunner({
      orchestrator,
      persistence: adapter,
      executorRegistry: { getDefault: () => ({ type: 'worktree' }), get: () => null, getAll: () => [] } as any,
      cwd: '/runner-base-cwd',
      mergeGateProvider: stubMergeGateProvider(openProviderIds),
    });
  }

  function persistedTask(): TaskState {
    return adapter.loadTasks(WORKFLOW.id).find((candidate) => candidate.id === TASK_ID)!;
  }

  function persistedArtifactStatuses(): Record<string, string> {
    return Object.fromEntries(
      persistedTask().execution.reviewGate!.artifacts.map((artifact) => [artifact.providerId, artifact.status]),
    );
  }

  it('keeps every merged artifact approved and completes the gate', async () => {
    await createRunner(new Set()).checkMergeGateStatuses();

    expect(persistedArtifactStatuses()).toEqual(
      Object.fromEntries(PROVIDER_IDS.map((providerId) => [providerId, 'approved'])),
    );
    expect(persistedTask().status).toBe('completed');
  });

  it('keeps the eight merged artifacts approved and leaves the gate review_ready while one PR is open', async () => {
    const openProviderId = PROVIDER_IDS[4];

    await createRunner(new Set([openProviderId])).checkMergeGateStatuses();

    expect(persistedArtifactStatuses()).toEqual(
      Object.fromEntries(
        PROVIDER_IDS.map((providerId) => [providerId, providerId === openProviderId ? 'open' : 'approved']),
      ),
    );
    expect(persistedTask().status).toBe('review_ready');
  });
});

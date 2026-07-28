import { describe, expect, it, vi } from 'vitest';

import type {
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  buildRepairWorkflowSpec,
  queueRepairWorkflowSpawn,
  type RepairWorkflowSpawnStore,
  type RepairWorkflowSpawnSubmitter,
} from '../repair-workflow-spec.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';

const HEAD_A = 'abcdef1234567890abcdef1234567890abcdef12';
const HEAD_B = 'bbbbbb1234567890abcdef1234567890abcdef12';

function makeCiFailedEvent(
  overrides: Partial<ReviewGateCiFailedLifecycleEvent> = {},
): ReviewGateCiFailedLifecycleEvent {
  const headSha = overrides.headSha ?? HEAD_A;
  return {
    eventKey: `review_gate.ci_failed|workflow:wf-up|task:__merge__wf-up|review:123:${headSha}`,
    kind: 'review_gate.ci_failed',
    workflowId: 'wf-up',
    taskId: '__merge__wf-up',
    status: 'review_ready',
    taskStateVersion: 12,
    generation: 7,
    attemptId: 'attempt-merge',
    createdAt: '2026-01-01T00:00:00.000Z',
    recoveryWakeup: {
      eventKey: `review_gate.ci_failed|workflow:wf-up|task:__merge__wf-up|review:123:${headSha}`,
      eventKind: 'review_gate.ci_failed',
      workflowId: 'wf-up',
      taskId: '__merge__wf-up',
      taskStateVersion: 12,
      generation: 7,
      attemptId: 'attempt-merge',
      createdAt: '2026-01-01T00:00:00.000Z',
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha,
    headRef: 'feature/ci-red',
    branch: 'feature/ci-red',
    failedChecks: [
      { name: 'test-all', conclusion: 'FAILURE', detailsUrl: 'https://ci.example/test-all' },
      { name: 'lint', conclusion: 'FAILURE' },
    ],
    statusText: 'CI failed',
    ...overrides,
  };
}

function makeReviewGateTask(): TaskState {
  return {
    id: '__merge__wf-up',
    description: 'Merge gate',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-up', isMergeNode: true, runnerKind: 'merge' },
    execution: {
      generation: 7,
      selectedAttemptId: 'attempt-merge',
      branch: 'feature/ci-red',
    },
    taskStateVersion: 12,
  } as TaskState;
}

function makeStore(): RepairWorkflowSpawnStore & { actions: Map<string, WorkerActionRecord> } {
  const task = makeReviewGateTask();
  const actions = new Map<string, WorkerActionRecord>();
  return {
    actions,
    loadTasks: vi.fn((workflowId: string) => (workflowId === 'wf-up' ? [task] : [])),
    loadTask: vi.fn((taskId: string) => (taskId === task.id ? task : undefined)),
    loadWorkflow: vi.fn((workflowId: string) => (
      workflowId === 'wf-up'
        ? {
          id: 'wf-up',
          name: 'Upstream workflow',
          repoUrl: 'https://github.com/owner/repo.git',
          featureBranch: 'feature/ci-red',
          baseBranch: 'master',
        }
        : undefined
    )),
    listWorkflows: vi.fn(() => [{
      id: 'wf-up',
      name: 'Upstream workflow',
      repoUrl: 'https://github.com/owner/repo.git',
      featureBranch: 'feature/ci-red',
      baseBranch: 'master',
    }]),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const now = '2026-01-01T00:00:00.000Z';
      const saved = {
        ...write,
        id: existing?.id ?? write.id,
        attemptCount: write.attemptCount ?? 0,
        createdAt: existing?.createdAt ?? write.createdAt ?? now,
        updatedAt: write.updatedAt ?? now,
      } as WorkerActionRecord;
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
}

function makeSubmitter(): RepairWorkflowSpawnSubmitter & { submit: ReturnType<typeof vi.fn> } {
  return {
    submit: vi.fn((
      _workflowId: string,
      _priority: WorkflowMutationPriority,
      _channel: 'invoker:spawn-repair-workflow',
      _args: unknown[],
    ) => 42),
  };
}

describe('repair workflow spec', () => {
  it('builds an explicit repair workflow with ci_failed dependency and repair branch', () => {
    const event = makeCiFailedEvent();
    const spec = buildRepairWorkflowSpec({
      event,
      upstreamWorkflowId: 'wf-up',
      upstreamFeatureBranch: 'feature/ci-red',
      prHeadSha: HEAD_A,
      failedCheckNames: ['test-all', 'lint'],
      repoUrl: 'https://github.com/owner/repo.git',
    });

    expect(spec).toMatchObject({
      onFinish: 'none',
      baseBranch: HEAD_A,
      featureBranch: 'repair/feature/ci-red-abcdef123456',
      externalDependencies: [{
        workflowId: 'wf-up',
        taskId: '__merge__',
        gatePolicy: 'ci_failed',
      }],
    });
    expect(spec.tasks.map((task) => task.id)).toEqual(['repair-ci', 'publish-repair']);
    expect(spec.tasks[1]).toMatchObject({
      id: 'publish-repair',
      dependencies: ['repair-ci'],
    });
  });

  it('wires the final step to refuse moved PR heads and avoid force pushes', () => {
    const spec = buildRepairWorkflowSpec({
      event: makeCiFailedEvent(),
      upstreamWorkflowId: 'wf-up',
      upstreamFeatureBranch: 'feature/ci-red',
      prHeadSha: HEAD_A,
      failedCheckNames: ['test-all'],
      repoUrl: 'https://github.com/owner/repo.git',
    });
    const publishCommand = spec.tasks.find((task) => task.id === 'publish-repair')?.command;

    expect(publishCommand).toContain(`expected_head='${HEAD_A}'`);
    expect(publishCommand).toContain('if [ "$current_head" != "$expected_head" ]; then');
    expect(publishCommand).toContain('Refusing repair publish.');
    expect(publishCommand).toContain('exit 42');
    expect(publishCommand).toContain('git merge-base --is-ancestor "$expected_head" HEAD');
    expect(publishCommand).toContain('git push "$remote" "refs/heads/${repair_branch}:refs/heads/${feature_branch}"');
    expect(publishCommand).not.toContain('--force');
  });
});

describe('repair workflow spawn guards', () => {
  it('dedupes identical PR/head repair spawn intents', () => {
    const store = makeStore();
    const submitter = makeSubmitter();
    const event = makeCiFailedEvent();

    const first = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 3 }, event);
    const second = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 3 }, event);

    expect(first).toMatchObject({ decision: 'queued', reason: 'queued', intentId: 42 });
    expect(second).toMatchObject({ decision: 'skipped', reason: 'already-recorded' });
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });

  it('allows a fresh repair spawn for a new PR head SHA', () => {
    const store = makeStore();
    const submitter = makeSubmitter();

    const first = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 3 }, makeCiFailedEvent({ headSha: HEAD_A }));
    const second = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 3 }, makeCiFailedEvent({ headSha: HEAD_B }));

    expect(first.decision).toBe('queued');
    expect(second.decision).toBe('queued');
    expect(submitter.submit).toHaveBeenCalledTimes(2);
    expect((submitter.submit.mock.calls[0]?.[3] as unknown[])[0]).toMatchObject({ prHeadSha: HEAD_A });
    expect((submitter.submit.mock.calls[1]?.[3] as unknown[])[0]).toMatchObject({ prHeadSha: HEAD_B });
  });

  it('consumes the shared per-task spawn cap for worker repair spawns', () => {
    const store = makeStore();
    const submitter = makeSubmitter();

    const first = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 1 }, makeCiFailedEvent({ headSha: HEAD_A }));
    const second = queueRepairWorkflowSpawn({ store, submitter, defaultAutoFixRetries: 1 }, makeCiFailedEvent({ headSha: HEAD_B }));

    expect(first.decision).toBe('queued');
    expect(second).toMatchObject({ decision: 'skipped', reason: 'worker-retry-budget-exhausted' });
    expect(submitter.submit).toHaveBeenCalledTimes(1);
  });
});

import { describe, expect, it, vi } from 'vitest';

import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { recordAutoFixRetryConsumed } from '../auto-fix-retry-cap.js';
import type { ReviewGateCiFailedLifecycleEvent } from '../lifecycle-events.js';
import {
  REPAIR_WORKFLOW_FAST_FORWARD_TASK_ID,
  REPAIR_WORKFLOW_FIX_TASK_ID,
  SPAWN_REPAIR_WORKFLOW_CHANNEL,
  buildRepairWorkflowBranchName,
  buildRepairWorkflowSpawnRequest,
  buildRepairWorkflowSpec,
  queueRepairWorkflowSpawn,
  repairWorkflowSpawnActionKey,
} from '../repair-workflow-spec.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  const { config, execution, ...rest } = overrides;
  return {
    id: 'wf-upstream/merge',
    description: 'merge',
    status: 'review_ready',
    dependencies: [],
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    config: { workflowId: 'wf-upstream', isMergeNode: true, ...(config ?? {}) },
    execution: {
      generation: 2,
      selectedAttemptId: 'attempt-1',
      branch: 'feature/ci',
      ...(execution ?? {}),
    },
    taskStateVersion: 10,
    ...rest,
  } as TaskState;
}

function makeEvent(overrides: Partial<ReviewGateCiFailedLifecycleEvent> = {}): ReviewGateCiFailedLifecycleEvent {
  return {
    eventKey: 'review_gate.ci_failed|workflow:wf-upstream|task:wf-upstream/merge',
    kind: 'review_gate.ci_failed',
    workflowId: 'wf-upstream',
    taskId: 'wf-upstream/merge',
    status: 'review_ready',
    taskStateVersion: 10,
    generation: 2,
    attemptId: 'attempt-1',
    createdAt: '2026-01-01T00:00:00.000Z',
    recoveryWakeup: {
      eventKey: 'review_gate.ci_failed|workflow:wf-upstream|task:wf-upstream/merge',
      eventKind: 'review_gate.ci_failed',
      workflowId: 'wf-upstream',
      taskId: 'wf-upstream/merge',
      taskStateVersion: 10,
      generation: 2,
      attemptId: 'attempt-1',
      createdAt: '2026-01-01T00:00:00.000Z',
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'abcdef1234567890',
    headRef: 'feature/ci',
    branch: 'feature/ci',
    failedChecks: [
      { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
      { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
    ],
    statusText: 'CI failed',
    ...overrides,
  };
}

function toRecord(write: WorkerActionWrite): WorkerActionRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    ...write,
    attemptCount: write.attemptCount ?? 0,
    createdAt: write.createdAt ?? now,
    updatedAt: write.updatedAt ?? now,
  };
}

function makeHarness(task = makeTask()) {
  const tasks = new Map<string, TaskState>([[task.id, task]]);
  const actions = new Map<string, WorkerActionRecord>();
  const submit = vi.fn((workflowId: string, priority: WorkflowMutationPriority, channel: string, args: unknown[]) => {
    expect(workflowId).toBe('wf-upstream');
    expect(priority).toBe('normal');
    expect(channel).toBe(SPAWN_REPAIR_WORKFLOW_CHANNEL);
    expect(args).toHaveLength(1);
    return submit.mock.calls.length + 40;
  });
  const store = {
    loadTasks: vi.fn((workflowId: string) => workflowId === 'wf-upstream' ? Array.from(tasks.values()) : []),
    loadTask: vi.fn((taskId: string) => tasks.get(taskId)),
    loadWorkflow: vi.fn((workflowId: string) => workflowId === 'wf-upstream'
      ? {
        id: 'wf-upstream',
        name: 'Upstream',
        repoUrl: 'git@github.com:owner/repo.git',
        intermediateRepoUrl: 'git@github.com:owner/repo-branches.git',
        featureBranch: 'feature/ci',
      }
      : undefined),
    getWorkerAction: vi.fn((workerKind: string, externalKey: string) => actions.get(`${workerKind}:${externalKey}`)),
    upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
      const key = `${write.workerKind}:${write.externalKey}`;
      const existing = actions.get(key);
      const saved = toRecord({ ...write, id: existing?.id ?? write.id, createdAt: existing?.createdAt });
      actions.set(key, saved);
      return saved;
    }),
    logEvent: vi.fn(),
  };
  return { actions, store, submit };
}

describe('repair workflow spawn', () => {
  it('builds a repair workflow spec with ci_failed upstream dependency and repair branch', () => {
    const event = makeEvent();
    const request = buildRepairWorkflowSpawnRequest(event, {
      upstreamWorkflow: {
        id: 'wf-upstream',
        repoUrl: 'git@github.com:owner/repo.git',
        featureBranch: 'feature/ci',
      },
      failedCheckNames: ['unit', 'lint'],
    });

    const spec = buildRepairWorkflowSpec(request);

    expect(spec).toMatchObject({
      onFinish: 'none',
      mergeMode: 'manual',
      repoUrl: 'git@github.com:owner/repo.git',
      baseBranch: 'abcdef1234567890',
      featureBranch: 'repair/feature/ci-abcdef12',
      externalDependencies: [{
        workflowId: 'wf-upstream',
        taskId: '__merge__',
        requiredStatus: 'completed',
        gatePolicy: 'ci_failed',
      }],
    });
    expect(spec.tasks.map((task) => task.id)).toEqual([
      REPAIR_WORKFLOW_FIX_TASK_ID,
      REPAIR_WORKFLOW_FAST_FORWARD_TASK_ID,
    ]);
    expect(spec.tasks[0]?.prompt).toContain('Failed check names:\n- unit\n- lint');
    expect(spec.tasks[1]).toMatchObject({
      dependencies: [REPAIR_WORKFLOW_FIX_TASK_ID],
      featureBranch: 'repair/feature/ci-abcdef12',
    });
  });

  it('dedupes identical upstream PR and head SHA repair spawn submissions', async () => {
    const event = makeEvent();
    const harness = makeHarness();

    const first = await queueRepairWorkflowSpawn({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, event);
    const second = await queueRepairWorkflowSpawn({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, event);

    expect(first).toMatchObject({ decision: 'queued', reason: 'queued', intentId: 41 });
    expect(second).toEqual({ decision: 'skipped', reason: 'already-recorded' });
    expect(harness.submit).toHaveBeenCalledTimes(1);
    expect(harness.actions.get(`ci-failure:${repairWorkflowSpawnActionKey(event)}`)).toMatchObject({
      actionType: 'spawn-repair-workflow',
      status: 'queued',
      intentId: '41',
    });
  });

  it('allows a fresh repair spawn for a new PR head SHA', async () => {
    const harness = makeHarness();
    const firstEvent = makeEvent({ headSha: 'abcdef1234567890' });
    const secondEvent = makeEvent({ headSha: '1234567890abcdef' });

    const first = await queueRepairWorkflowSpawn({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, firstEvent);
    const second = await queueRepairWorkflowSpawn({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 2,
    }, secondEvent);

    expect(first.decision).toBe('queued');
    expect(second.decision).toBe('queued');
    expect(harness.submit).toHaveBeenCalledTimes(2);
    expect((harness.submit.mock.calls[0]?.[3]?.[0] as { prHeadSha?: string }).prHeadSha).toBe('abcdef1234567890');
    expect((harness.submit.mock.calls[1]?.[3]?.[0] as { prHeadSha?: string }).prHeadSha).toBe('1234567890abcdef');
  });

  it('skips automatic repair spawn when the per-task retry cap is exhausted', async () => {
    const event = makeEvent();
    const harness = makeHarness();
    recordAutoFixRetryConsumed(harness.store, event.taskId, { workflowId: event.workflowId });

    const result = await queueRepairWorkflowSpawn({
      store: harness.store,
      submitter: { submit: harness.submit },
      logger,
      defaultAutoFixRetries: 1,
    }, event);

    expect(result).toEqual({ decision: 'skipped', reason: 'worker-retry-budget-exhausted' });
    expect(harness.submit).not.toHaveBeenCalled();
  });

  it('wires final step to refuse branch moves before fast-forwarding the PR branch', () => {
    const event = makeEvent();
    const request = buildRepairWorkflowSpawnRequest(event, {
      upstreamWorkflow: {
        id: 'wf-upstream',
        repoUrl: 'git@github.com:owner/repo.git',
        featureBranch: 'feature/ci',
      },
    });
    const spec = buildRepairWorkflowSpec(request);
    const finalCommand = spec.tasks.find((task) => task.id === REPAIR_WORKFLOW_FAST_FORWARD_TASK_ID)?.command ?? '';

    expect(buildRepairWorkflowBranchName('feature/ci', 'abcdef1234567890')).toBe('repair/feature/ci-abcdef12');
    expect(finalCommand).toContain('EXPECTED_HEAD_SHA=');
    expect(finalCommand).toContain('CURRENT_HEAD_SHA=$(git rev-parse "refs/remotes/origin/$UPSTREAM_BRANCH^{commit}")');
    expect(finalCommand).toContain('PR branch moved since repair workflow was spawned');
    expect(finalCommand).toContain('git merge-base --is-ancestor "$EXPECTED_HEAD_SHA" HEAD');
    expect(finalCommand).toContain('git push origin "HEAD:refs/heads/$REPAIR_BRANCH"');
    expect(finalCommand).toContain('git push origin "HEAD:refs/heads/$UPSTREAM_BRANCH"');
    expect(finalCommand).not.toContain('--force');
    expect(finalCommand).not.toContain('git merge ');
  });
});

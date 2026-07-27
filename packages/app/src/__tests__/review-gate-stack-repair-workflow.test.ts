import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { ReviewGateCiRepairWorkflowMutationArgs, StackPrRecord } from '@invoker/execution-engine';
import type { PlanDefinition } from '@invoker/workflow-core';

import {
  assertMembersNotStale,
  buildStackRepairPlanTasks,
  spawnReviewGateStackCiRepairWorkflow,
} from '../review-gate-stack-repair-workflow.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

const SOURCE_PLAN: PlanDefinition = {
  name: 'Source review gate workflow',
  onFinish: 'none',
  mergeMode: 'manual',
  baseBranch: 'master',
  featureBranch: 'feature/review-gate-ci',
  repoUrl: 'memory://repo.git',
  intermediateRepoUrl: 'memory://intermediate.git',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
  ],
};

async function driveSourceGateToReviewReady(
  h: TestHarness,
): Promise<{ workflowId: string; mergeId: string }> {
  h.loadAndStart(SOURCE_PLAN);
  h.completeTask('A');
  const mergeTask = h.getAllTasks().find((task) => task.config.isMergeNode);
  expect(mergeTask).toBeDefined();
  await h.executor.executeTasks([mergeTask!]);
  expect(h.getTask(mergeTask!.id)?.status).toBe('review_ready');

  const gate = h.getTask(mergeTask!.id)!;
  const generation = gate.execution.generation ?? 0;
  h.persistence.updateTask(mergeTask!.id, {
    execution: {
      reviewId: '9501',
      branch: 'feature/review-gate-ci',
      reviewGate: {
        activeGeneration: generation,
        completion: gate.execution.reviewGate?.completion ?? { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-9501',
          providerId: '9501',
          provider: 'github',
          required: true,
          status: 'open',
          generation,
          headSha: 'sha-9501',
        }],
      },
    },
  });
  h.orchestrator.getWorkflowStatus();
  return { workflowId: gate.config.workflowId!, mergeId: mergeTask!.id };
}

function makeTriggeringArgs(
  h: TestHarness,
  mergeId: string,
  workflowId: string,
  overrides: Partial<ReviewGateCiRepairWorkflowMutationArgs> = {},
): ReviewGateCiRepairWorkflowMutationArgs {
  const gate = h.getTask(mergeId)!;
  return {
    sourceWorkflowId: workflowId,
    sourceTaskId: mergeId,
    reviewId: '9501',
    reviewUrl: 'https://github.com/owner/repo/pull/9501',
    headSha: 'sha-9501',
    headRef: 'stack/bottom',
    branch: 'feature/review-gate-ci',
    generation: gate.execution.generation ?? 0,
    selectedAttemptId: gate.execution.selectedAttemptId,
    failedChecks: [{ name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' }],
    statusText: 'CI failed',
    taskStateVersion: gate.taskStateVersion,
    ...overrides,
  };
}

function member(overrides: Partial<StackPrRecord> & { number: number }): StackPrRecord {
  return {
    state: 'OPEN',
    baseRefName: 'master',
    headRefName: `stack/pr-${overrides.number}`,
    headRefOid: `sha-${overrides.number}`,
    ...overrides,
  };
}

const BASE_TRIGGERING: ReviewGateCiRepairWorkflowMutationArgs = {
  sourceWorkflowId: 'wf-1',
  sourceTaskId: 'wf-1/merge',
  reviewId: '9001',
  reviewUrl: 'https://github.com/owner/repo/pull/9001',
  headSha: 'sha-9001',
  generation: 0,
  failedChecks: [
    { name: 'unit', conclusion: 'FAILURE' },
    { name: 'lint', conclusion: 'FAILURE' },
  ],
  statusText: 'CI failed',
  taskStateVersion: 1,
};

describe('buildStackRepairPlanTasks', () => {
  it('Case A: only the triggering (bottom) PR gets check-fix tasks; every member gets a chained recheck task', () => {
    const members = [
      member({ number: 9001, headRefName: 'stack/a' }),
      member({ number: 9002, baseRefName: 'stack/a', headRefName: 'stack/b' }),
      member({ number: 9003, baseRefName: 'stack/b', headRefName: 'stack/c' }),
    ];

    const tasks = buildStackRepairPlanTasks(members, BASE_TRIGGERING, 'master');

    expect(tasks.map((t) => t.id)).toEqual([
      'pr-9001-check-0-unit',
      'pr-9001-check-1-lint',
      'pr-9001-recheck',
      'pr-9002-recheck',
      'pr-9003-recheck',
    ]);
    expect(tasks.find((t) => t.id === 'pr-9001-check-0-unit')?.dependencies).toBeUndefined();
    expect(tasks.find((t) => t.id === 'pr-9001-recheck')?.dependencies).toEqual([
      'pr-9001-check-0-unit',
      'pr-9001-check-1-lint',
    ]);
    expect(tasks.find((t) => t.id === 'pr-9002-recheck')?.dependencies).toEqual(['pr-9001-recheck']);
    expect(tasks.find((t) => t.id === 'pr-9003-recheck')?.dependencies).toEqual(['pr-9002-recheck']);
  });

  it('Case B: a middle-of-stack trigger gates its own check tasks on the PR below AND gates the PR above on itself', () => {
    const members = [
      member({ number: 9101, headRefName: 'stack/x' }),
      member({ number: 9102, baseRefName: 'stack/x', headRefName: 'stack/y' }),
    ];
    const triggering: ReviewGateCiRepairWorkflowMutationArgs = {
      ...BASE_TRIGGERING,
      reviewId: '9102',
      failedChecks: [{ name: 'e2e', conclusion: 'FAILURE' }],
    };

    const tasks = buildStackRepairPlanTasks(members, triggering, 'master');

    expect(tasks.map((t) => t.id)).toEqual(['pr-9101-recheck', 'pr-9102-check-0-e2e', 'pr-9102-recheck']);
    expect(tasks.find((t) => t.id === 'pr-9101-recheck')?.dependencies).toEqual([]);
    // The bottom PR has no failing checks assigned to this batch, so its recheck
    // has no dependencies of its own -- but everything on PR #9102 still waits
    // on PR #9101's recheck completing first.
    expect(tasks.find((t) => t.id === 'pr-9102-check-0-e2e')?.dependencies).toEqual(['pr-9101-recheck']);
    expect(tasks.find((t) => t.id === 'pr-9102-recheck')?.dependencies).toEqual([
      'pr-9102-check-0-e2e',
      'pr-9101-recheck',
    ]);
  });

  it('gives every member a featureBranch matching its own head branch', () => {
    const members = [
      member({ number: 9201, headRefName: 'stack/one' }),
      member({ number: 9202, baseRefName: 'stack/one', headRefName: 'stack/two' }),
    ];
    const tasks = buildStackRepairPlanTasks(members, { ...BASE_TRIGGERING, reviewId: '9201' }, 'master');

    expect(tasks.find((t) => t.id === 'pr-9201-recheck')?.featureBranch).toBe('stack/one');
    expect(tasks.find((t) => t.id === 'pr-9202-recheck')?.featureBranch).toBe('stack/two');
  });
});

describe('assertMembersNotStale', () => {
  it('Case C: throws when a member head SHA changed since detection', async () => {
    const detected = [
      member({ number: 9101, headRefName: 'stack/x', headRefOid: 'sha-a' }),
      member({ number: 9102, baseRefName: 'stack/x', headRefName: 'stack/y', headRefOid: 'sha-b' }),
    ];
    const fetchOpenStackPrs = async () => [
      detected[0],
      { ...detected[1], headRefOid: 'sha-b-changed-by-a-push' },
    ];

    await expect(assertMembersNotStale(detected, fetchOpenStackPrs)).rejects.toThrow(
      'PR #9102 head changed (sha-b → sha-b-changed-by-a-push)',
    );
  });

  it('throws when a member is no longer open (merged or closed out from under the batch)', async () => {
    const detected = [member({ number: 9201 })];
    const fetchOpenStackPrs = async () => [];

    await expect(assertMembersNotStale(detected, fetchOpenStackPrs)).rejects.toThrow(
      'PR #9201 is no longer open',
    );
  });

  it('resolves without throwing when nothing has changed', async () => {
    const detected = [member({ number: 9301 }), member({ number: 9302, baseRefName: 'stack/pr-9301' })];
    await expect(assertMembersNotStale(detected, async () => detected)).resolves.toBeUndefined();
  });
});

describe('spawnReviewGateStackCiRepairWorkflow', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('Case C: aborts before creating any workflow when a member has gone stale', async () => {
    const { workflowId, mergeId } = await driveSourceGateToReviewReady(h);
    const triggering = makeTriggeringArgs(h, mergeId, workflowId);
    const members = [member({ number: 9501, headRefName: 'stack/bottom', headRefOid: 'sha-9501' })];
    const workflowIdsBefore = h.persistence.listWorkflows().map((workflow) => workflow.id);

    await expect(spawnReviewGateStackCiRepairWorkflow(
      { stackId: 'stack:master:9501', members, triggering },
      {
        orchestrator: h.orchestrator,
        persistence: h.persistence,
        logger,
        // Live state disagrees with detection-time state -> fail closed.
        fetchOpenStackPrs: async () => [{ ...members[0], headRefOid: 'sha-9501-moved' }],
      },
    )).rejects.toThrow('PR #9501 head changed');

    expect(h.persistence.listWorkflows().map((workflow) => workflow.id)).toEqual(workflowIdsBefore);
  });

  it('Case D: a permanently-stuck bottom PR blocks the PR above it without ever marking it stale', async () => {
    const { workflowId, mergeId } = await driveSourceGateToReviewReady(h);
    const triggering = makeTriggeringArgs(h, mergeId, workflowId);
    const members = [
      member({ number: 9501, headRefName: 'stack/bottom', headRefOid: 'sha-9501' }),
      member({ number: 9502, baseRefName: 'stack/bottom', headRefName: 'stack/top', headRefOid: 'sha-9502' }),
    ];

    const result = await spawnReviewGateStackCiRepairWorkflow(
      { stackId: 'stack:master:9501,9502', members, triggering },
      {
        orchestrator: h.orchestrator,
        persistence: h.persistence,
        logger,
        fetchOpenStackPrs: async () => members,
      },
    );

    const bottomRecheckId = result.memberTaskIds[9501];
    const topRecheckId = result.memberTaskIds[9502];
    const checkTaskId = result.started.find((task) => task.id.endsWith('check-0-unit'))!.id;

    // Before the bottom PR's own check is even fixed, the PR above it must not
    // have started -- and simulating "permanently stuck" (never completing the
    // bottom recheck task, never marking it `stale`) must keep it that way.
    expect(h.getTask(topRecheckId)?.status).not.toBe('running');
    expect(h.getTask(topRecheckId)?.status).not.toBe('completed');

    h.completeTask(checkTaskId);
    // Bottom PR's recheck task is now unblocked and running, but has NOT
    // completed -- the "permanently stuck, needs a human" case. It must never
    // be marked `stale` (that status would spuriously satisfy the PR-above's
    // dependency in ActionGraph.getReadyNodes()).
    expect(h.getTask(bottomRecheckId)?.status).toBe('running');
    expect(h.getTask(topRecheckId)?.status).not.toBe('running');
    expect(h.getTask(topRecheckId)?.status).not.toBe('completed');
    expect(h.getTask(bottomRecheckId)?.status).not.toBe('stale');

    // Only once the bottom PR's recheck genuinely completes does the PR above
    // it become ready and auto-start.
    h.completeTask(bottomRecheckId);
    expect(h.getTask(topRecheckId)?.status).toBe('running');
  });
});

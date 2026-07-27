import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createTestHarness, type TestHarness } from '@invoker/test-kit';
import type { ReviewGateCiRepairWorkflowMutationArgs } from '@invoker/execution-engine';
import type { PlanDefinition } from '@invoker/workflow-core';

import { spawnReviewGateCiRepairWorkflow } from '../review-gate-ci-repair-workflow.js';

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
  baseBranch: 'main',
  featureBranch: 'feature/review-gate-ci',
  repoUrl: 'memory://repo.git',
  intermediateRepoUrl: 'memory://intermediate.git',
  tasks: [
    { id: 'A', description: 'Task A', command: 'echo a' },
  ],
};

async function driveSourceGateToReviewReady(
  h: TestHarness,
  plan: PlanDefinition = SOURCE_PLAN,
): Promise<{ workflowId: string; mergeId: string }> {
  h.loadAndStart(plan);
  h.completeTask('A');
  const mergeTask = h.getAllTasks().find((task) => task.config.isMergeNode);
  expect(mergeTask).toBeDefined();
  await h.executor.executeTasks([mergeTask!]);
  expect(h.getTask(mergeTask!.id)?.status).toBe('review_ready');

  const gate = h.getTask(mergeTask!.id)!;
  const generation = gate.execution.generation ?? 0;
  h.persistence.updateTask(mergeTask!.id, {
    execution: {
      reviewId: '123',
      branch: 'feature/review-gate-ci',
      reviewGate: {
        activeGeneration: generation,
        completion: gate.execution.reviewGate?.completion ?? { required: 'all', status: 'approved' },
        artifacts: [{
          id: 'pr-123',
          providerId: '123',
          provider: 'github',
          required: true,
          status: 'open',
          generation,
          headSha: 'sha-1',
        }],
      },
    },
  });
  h.orchestrator.getWorkflowStatus();
  return { workflowId: gate.config.workflowId!, mergeId: mergeTask!.id };
}

function makeArgs(h: TestHarness, mergeId: string, workflowId: string): ReviewGateCiRepairWorkflowMutationArgs {
  const gate = h.getTask(mergeId)!;
  return {
    sourceWorkflowId: workflowId,
    sourceTaskId: mergeId,
    reviewId: '123',
    reviewUrl: 'https://github.com/owner/repo/pull/123',
    headSha: 'sha-1',
    headRef: 'feature/review-gate-ci',
    branch: 'feature/review-gate-ci',
    generation: gate.execution.generation ?? 0,
    selectedAttemptId: gate.execution.selectedAttemptId,
    failedChecks: [
      { name: 'unit', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/1' },
      { name: 'lint', conclusion: 'FAILURE', detailsUrl: 'https://github.com/owner/repo/actions/2' },
    ],
    statusText: 'CI failed',
    taskStateVersion: gate.taskStateVersion,
    agentName: 'codex',
    executionModel: 'openai/gpt-5.2',
  };
}

describe('spawnReviewGateCiRepairWorkflow', () => {
  let h: TestHarness;

  beforeEach(() => {
    h = createTestHarness();
  });

  it('spawns one repair workflow and leaves the source merge gate untouched', async () => {
    const { workflowId: sourceWorkflowId, mergeId } = await driveSourceGateToReviewReady(h);
    const args = makeArgs(h, mergeId, sourceWorkflowId);
    const sourceBefore = h.getTask(mergeId)!;
    const workflowIdsBefore = new Set(h.persistence.listWorkflows().map((workflow) => workflow.id));

    const result = await spawnReviewGateCiRepairWorkflow(args, {
      orchestrator: h.orchestrator,
      persistence: h.persistence,
      logger,
    });

    expect(result.workflowId).not.toBe(sourceWorkflowId);
    expect(result.taskId).toBe(`${result.workflowId}/repair`);
    expect(result.started.map((task) => task.id)).toEqual([`${result.workflowId}/repair`]);

    const spawnedWorkflowIds = h.persistence
      .listWorkflows()
      .map((workflow) => workflow.id)
      .filter((workflowId) => !workflowIdsBefore.has(workflowId));
    expect(spawnedWorkflowIds).toEqual([result.workflowId]);

    const spawnedWorkflow = h.persistence.loadWorkflow(result.workflowId);
    expect(spawnedWorkflow).toMatchObject({
      id: result.workflowId,
      name: 'repair-review-gate-ci-123-sha-1',
      onFinish: 'none',
      baseBranch: 'main',
      repoUrl: 'memory://repo.git',
      intermediateRepoUrl: 'memory://intermediate.git',
    });

    const spawnedTasks = h.persistence.loadTasks(result.workflowId);
    const repairTasks = spawnedTasks.filter((task) => !task.config.isMergeNode);
    expect(repairTasks).toHaveLength(1);
    expect(repairTasks[0]).toMatchObject({
      id: `${result.workflowId}/repair`,
      description: 'Repair PR #123: CI failed',
      status: 'running',
      config: {
        prompt: expect.stringContaining('git fetch origin feature/review-gate-ci && git checkout feature/review-gate-ci'),
        executionAgent: 'codex',
        executionModel: 'openai/gpt-5.2',
      },
    });

    const sourceAfter = h.getTask(mergeId)!;
    expect(sourceAfter.status).toBe('review_ready');
    expect(sourceAfter.taskStateVersion).toBe(sourceBefore.taskStateVersion);
    expect(sourceAfter.execution.generation).toBe(sourceBefore.execution.generation);
    expect(sourceAfter.execution.selectedAttemptId).toBe(sourceBefore.execution.selectedAttemptId);
  });

  it('rejects stale lineage without creating a workflow', async () => {
    const { workflowId: sourceWorkflowId, mergeId } = await driveSourceGateToReviewReady(h);
    const args = makeArgs(h, mergeId, sourceWorkflowId);
    const workflowIdsBefore = h.persistence.listWorkflows().map((workflow) => workflow.id);

    h.persistence.updateTask(mergeId, {
      execution: { generation: (args.generation ?? 0) + 1 },
    });
    h.orchestrator.getWorkflowStatus();

    await expect(spawnReviewGateCiRepairWorkflow(args, {
      orchestrator: h.orchestrator,
      persistence: h.persistence,
      logger,
    })).rejects.toThrow('Review-gate CI repair workflow is stale: generation changed');

    expect(h.persistence.listWorkflows().map((workflow) => workflow.id)).toEqual(workflowIdsBefore);
  });

  it('throws explicit branch and base-branch errors', async () => {
    const branchHarness = createTestHarness();
    const noBranchPlan: PlanDefinition = {
      ...SOURCE_PLAN,
      featureBranch: undefined,
    };
    const { workflowId: branchWorkflowId, mergeId: branchMergeId } = await driveSourceGateToReviewReady(
      branchHarness,
      noBranchPlan,
    );
    const branchArgs = makeArgs(branchHarness, branchMergeId, branchWorkflowId);
    const workflowIdsBefore = branchHarness.persistence.listWorkflows().map((workflow) => workflow.id);

    branchHarness.persistence.updateTask(branchMergeId, {
      execution: {
        branch: undefined,
        reviewGate: {
          activeGeneration: branchArgs.generation,
          completion: { required: 'all', status: 'approved' },
          artifacts: [{
            id: 'pr-123',
            providerId: '123',
            provider: 'github',
            required: true,
            status: 'open',
            generation: branchArgs.generation,
          }],
        },
      },
    });
    branchHarness.orchestrator.getWorkflowStatus();

    await expect(spawnReviewGateCiRepairWorkflow({
      ...branchArgs,
      branch: undefined,
      headSha: undefined,
    }, {
      orchestrator: branchHarness.orchestrator,
      persistence: branchHarness.persistence,
      logger,
    })).rejects.toThrow('Review-gate CI repair requires a branch to checkout.');

    const baseHarness = createTestHarness();
    const noBasePlan: PlanDefinition = {
      ...SOURCE_PLAN,
      baseBranch: undefined,
    };
    const { workflowId: baseWorkflowId, mergeId: baseMergeId } = await driveSourceGateToReviewReady(
      baseHarness,
      noBasePlan,
    );
    const baseArgs = makeArgs(baseHarness, baseMergeId, baseWorkflowId);

    await expect(spawnReviewGateCiRepairWorkflow(baseArgs, {
      orchestrator: baseHarness.orchestrator,
      persistence: baseHarness.persistence,
      logger,
    })).rejects.toThrow('Review-gate CI repair requires source workflow baseBranch.');

    expect(branchHarness.persistence.listWorkflows().map((workflow) => workflow.id)).toEqual(workflowIdsBefore);
  });
});

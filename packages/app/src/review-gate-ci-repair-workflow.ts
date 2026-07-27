import type { Logger } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { ReviewGateCiRepairWorkflowMutationArgs } from '@invoker/execution-engine';
import type { Orchestrator, PlanDefinition, TaskState } from '@invoker/workflow-core';

import { backupPlan } from './plan-backup.js';

export interface SpawnReviewGateCiRepairWorkflowDeps {
  orchestrator: Pick<Orchestrator, 'getWorkflowIds' | 'loadPlan' | 'startExecution'>;
  persistence: Pick<SQLiteAdapter, 'listWorkflows' | 'loadTasks' | 'loadWorkflow'> & {
    loadTask?: (taskId: string) => TaskState | undefined;
  };
  logger?: Logger;
  allowGraphMutation?: boolean;
}

export interface SpawnReviewGateCiRepairWorkflowResult {
  workflowId: string;
  taskId: string;
  started: TaskState[];
}

function currentReviewGateLineage(task: TaskState, reviewId: string): {
  reviewId?: string;
  generation: number;
  selectedAttemptId?: string;
  branch?: string;
  headSha?: string;
} {
  const gate = task.execution.reviewGate;
  const artifact = gate?.artifacts.find((candidate) =>
    candidate.generation === gate.activeGeneration
    && candidate.status !== 'discarded'
    && !candidate.discardedAt
    && candidate.providerId === reviewId,
  );
  return {
    reviewId: artifact?.providerId ?? task.execution.reviewId,
    generation: task.execution.generation ?? 0,
    selectedAttemptId: task.execution.selectedAttemptId,
    branch: task.execution.branch,
    headSha: artifact?.headSha,
  };
}

export function loadSourceTask(
  sourceWorkflowId: string,
  sourceTaskId: string,
  deps: SpawnReviewGateCiRepairWorkflowDeps,
): TaskState | undefined {
  const direct = deps.persistence.loadTask?.(sourceTaskId);
  if (direct) {
    return direct;
  }
  return deps.persistence.loadTasks(sourceWorkflowId).find((task) => task.id === sourceTaskId);
}

export function assertSourceReviewGateLineage(task: TaskState, args: ReviewGateCiRepairWorkflowMutationArgs): void {
  if (task.config.workflowId !== args.sourceWorkflowId) {
    throw new Error(
      `Review-gate CI repair workflow is stale: source workflow changed (${args.sourceWorkflowId} → ${task.config.workflowId ?? 'missing'}).`,
    );
  }
  if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') {
    throw new Error(
      `Review-gate CI repair workflow is stale: source task ${args.sourceTaskId} is ${task.status}.`,
    );
  }
  const current = currentReviewGateLineage(task, args.reviewId);
  if (current.reviewId !== args.reviewId) {
    throw new Error(
      `Review-gate CI repair workflow is stale: review changed (${args.reviewId} → ${current.reviewId ?? 'missing'}).`,
    );
  }
  if (current.generation !== args.generation) {
    throw new Error(
      `Review-gate CI repair workflow is stale: generation changed (${args.generation} → ${current.generation}).`,
    );
  }
  if (args.selectedAttemptId !== undefined && current.selectedAttemptId !== args.selectedAttemptId) {
    throw new Error(
      `Review-gate CI repair workflow is stale: selected attempt changed (${args.selectedAttemptId} → ${current.selectedAttemptId ?? 'missing'}).`,
    );
  }
  if (args.branch !== undefined && current.branch !== args.branch) {
    throw new Error(
      `Review-gate CI repair workflow is stale: branch changed (${args.branch} → ${current.branch ?? 'missing'}).`,
    );
  }
  if (args.headSha !== undefined && current.headSha !== args.headSha) {
    throw new Error(
      `Review-gate CI repair workflow is stale: head SHA changed (${args.headSha} → ${current.headSha ?? 'missing'}).`,
    );
  }
}

function resolveBranch(task: TaskState, featureBranch: string | undefined, args: ReviewGateCiRepairWorkflowMutationArgs): string {
  const branch = args.branch?.trim() || task.execution.branch?.trim() || featureBranch?.trim();
  if (!branch) {
    throw new Error('Review-gate CI repair requires a branch to checkout.');
  }
  return branch;
}

export function resolveBaseBranch(baseBranch: string | undefined): string {
  const resolved = baseBranch?.trim();
  if (!resolved) {
    throw new Error('Review-gate CI repair requires source workflow baseBranch.');
  }
  return resolved;
}

export function buildFailedCheckBullet(check: ReviewGateCiRepairWorkflowMutationArgs['failedChecks'][number]): string {
  const conclusion = check.conclusion ? ` (${check.conclusion})` : '';
  const detailsUrl = check.detailsUrl ? ` — ${check.detailsUrl}` : '';
  return `- ${check.name}${conclusion}${detailsUrl}`;
}

function buildRepairPrompt(
  args: ReviewGateCiRepairWorkflowMutationArgs,
  branch: string,
  baseBranch: string,
): string {
  const failedChecks = args.failedChecks.map(buildFailedCheckBullet).join('\n');
  return [
    `Repair the existing pull request #${args.reviewId}.`,
    `PR URL: ${args.reviewUrl}`,
    `Head branch: ${branch}`,
    `Head SHA: ${args.headSha ?? 'unknown'}`,
    `Base branch: ${baseBranch}`,
    '',
    `Source workflow: ${args.sourceWorkflowId}`,
    `Source merge task: ${args.sourceTaskId}`,
    `Status: ${args.statusText}`,
    '',
    'Work directly on the review branch:',
    `  git fetch origin ${branch} && git checkout ${branch}`,
    '',
    'Failed checks to clear:',
    failedChecks,
    '',
    'Rules:',
    '- Fix the failing checks on the same branch.',
    `- Push your changes to the same branch (${branch}).`,
    '- Never open a new PR.',
    '- Do not recreate the source workflow.',
  ].join('\n');
}

export async function spawnReviewGateCiRepairWorkflow(
  args: ReviewGateCiRepairWorkflowMutationArgs,
  deps: SpawnReviewGateCiRepairWorkflowDeps,
): Promise<SpawnReviewGateCiRepairWorkflowResult> {
  const sourceTask = loadSourceTask(args.sourceWorkflowId, args.sourceTaskId, deps);
  if (!sourceTask) {
    throw new Error(`Review-gate CI repair source task ${args.sourceTaskId} not found.`);
  }
  const sourceWorkflow = deps.persistence.loadWorkflow(args.sourceWorkflowId);
  if (!sourceWorkflow) {
    throw new Error(`Review-gate CI repair source workflow ${args.sourceWorkflowId} not found.`);
  }

  assertSourceReviewGateLineage(sourceTask, args);

  const branch = resolveBranch(sourceTask, sourceWorkflow.featureBranch, args);
  const baseBranch = resolveBaseBranch(sourceWorkflow.baseBranch);
  const headShaOrNoHead = args.headSha ?? 'no-head';
  const plan: PlanDefinition = {
    name: `repair-review-gate-ci-${args.reviewId}-${headShaOrNoHead}`,
    onFinish: 'none',
    baseBranch,
    ...(sourceWorkflow.repoUrl ? { repoUrl: sourceWorkflow.repoUrl } : {}),
    ...(sourceWorkflow.intermediateRepoUrl ? { intermediateRepoUrl: sourceWorkflow.intermediateRepoUrl } : {}),
    tasks: [
      {
        id: 'repair',
        description: `Repair PR #${args.reviewId}: ${args.statusText}`,
        prompt: buildRepairPrompt(args, branch, baseBranch),
        ...(args.agentName ? { executionAgent: args.agentName } : {}),
        ...(args.executionModel ? { executionModel: args.executionModel } : {}),
        ...(args.poolId ? { poolId: args.poolId } : {}),
      },
    ],
  };

  const existingWorkflowIds = new Set(deps.persistence.listWorkflows().map((workflow) => workflow.id));
  backupPlan(plan, undefined, deps.logger);
  deps.orchestrator.loadPlan(plan, { allowGraphMutation: deps.allowGraphMutation });
  const workflowId = deps.orchestrator.getWorkflowIds().find((id) => !existingWorkflowIds.has(id));
  if (!workflowId) {
    throw new Error('Loaded review-gate CI repair plan did not create a workflow.');
  }
  const started = deps.orchestrator
    .startExecution()
    .filter((task) => task.config.workflowId === workflowId);
  return {
    workflowId,
    taskId: `${workflowId}/repair`,
    started,
  };
}

import type { Logger } from '@invoker/contracts';
import type {
  Workflow,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
  WorkerActionRecord,
} from '@invoker/data-store';
import {
  ciFailureActionKey,
  ciFailureChecksHash,
  createAutoFixAttemptLedger,
  queueReviewGateCiRepair,
  type AutoFixAttemptLedger,
  type ReviewGateCiFailedLifecycleEvent,
  type ReviewGateCiRepairResult,
  type ReviewGateCiRepairStore,
  type ReviewGateCiRepairSubmitter,
  type ReviewGateFailedCheck,
} from '@invoker/execution-engine';
import type { TaskState, TaskStatus } from '@invoker/workflow-core';

type ReviewGateArtifact = {
  id?: string;
  providerId?: string;
  provider?: string;
  required?: boolean;
  status?: string;
  generation?: number;
  url?: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  checksState?: string;
  failedChecks?: readonly ReviewGateFailedCheck[];
  mergeState?: string;
  rawStatus?: string;
  discardedAt?: string;
};

type ReviewGateState = {
  activeGeneration?: number;
  artifacts?: readonly ReviewGateArtifact[];
};

type ReviewGateTaskState = TaskState & {
  execution: TaskState['execution'] & {
    reviewGate?: ReviewGateState;
  };
};

export type ReviewGateCiRepairDecision = 'queued' | 'skipped' | 'unmapped';

export type ReviewGateCiRepairCommandResult =
  | {
      decision: 'unmapped';
      reason: 'no-matching-review-gate';
      target: string;
      prNumber?: string;
    }
  | {
      decision: 'queued' | 'skipped';
      reason: string;
      target: string;
      prNumber?: string;
      workflowId: string;
      workflowName?: string;
      taskId: string;
      taskStatus: TaskStatus;
      reviewId: string;
      reviewUrl: string;
      headSha?: string;
      failedChecks: ReviewGateFailedCheck[];
      intentId?: number;
      actionKey?: string;
    };

export type ReviewGateQueryResult = {
  state: 'mapped' | 'unmapped';
  target: string;
  prNumber?: string;
  workflowId?: string;
  workflowName?: string;
  taskId?: string;
  taskStatus?: TaskStatus;
  reviewId?: string;
  reviewUrl?: string;
  ciRepair?: {
    state: 'available' | 'not_available' | 'merge_conflict';
    reason?: string;
    headSha?: string;
    failedChecks?: ReviewGateFailedCheck[];
    actionKey?: string;
    action?: Pick<
      WorkerActionRecord,
      'status' | 'summary' | 'intentId' | 'agentName' | 'executionModel' | 'attemptCount' | 'updatedAt' | 'completedAt'
    >;
  };
};

export type ReviewGateCiRepairCommandStore = ReviewGateCiRepairStore & {
  listWorkflows(): Array<Pick<Workflow, 'id' | 'name'> & Partial<Workflow>>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
};

export interface ReviewGateCiRepairCommandOptions {
  store: ReviewGateCiRepairCommandStore;
  submitter: ReviewGateCiRepairSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  attemptLedger?: AutoFixAttemptLedger;
  now?: () => string;
}

export interface ReviewGateQueryOptions {
  store: ReviewGateCiRepairCommandStore;
}

const commandAttemptLedger = createAutoFixAttemptLedger();
const CI_FAILURE_WORKER_KIND = 'ci-failure';

function normalizePrUrl(value: string): string {
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return trimmed.replace(/\/$/, '');
  }
}

function extractPrNumber(target: string): string | undefined {
  const trimmed = target.trim();
  if (/^\d+$/.test(trimmed)) return trimmed;
  const hashMatch = trimmed.match(/#(\d+)$/);
  if (hashMatch?.[1]) return hashMatch[1];
  try {
    const url = new URL(trimmed);
    const match = url.pathname.match(/\/pull\/(\d+)(?:\/|$)/);
    return match?.[1];
  } catch {
    const match = trimmed.match(/\/pull\/(\d+)(?:[/?#]|$)/);
    return match?.[1];
  }
}

function reviewGateForTask(task: TaskState): ReviewGateState | undefined {
  return (task as ReviewGateTaskState).execution.reviewGate;
}

function taskReviewId(task: TaskState): string | undefined {
  return task.execution.reviewId;
}

function artifactReviewId(task: TaskState, artifact: ReviewGateArtifact): string | undefined {
  return artifact.providerId ?? artifact.id ?? taskReviewId(task);
}

function reviewIdMatchesTarget(reviewId: string | undefined, prNumber: string | undefined, target: string): boolean {
  if (!reviewId) return false;
  if (reviewId === target) return true;
  return Boolean(prNumber && (reviewId === prNumber || reviewId.endsWith(`#${prNumber}`)));
}

function reviewUrlMatchesTarget(reviewUrl: string | undefined, prNumber: string | undefined, target: string): boolean {
  if (!reviewUrl) return false;
  const normalizedReviewUrl = normalizePrUrl(reviewUrl);
  const normalizedTarget = normalizePrUrl(target);
  if (normalizedReviewUrl === normalizedTarget) return true;
  return Boolean(prNumber && extractPrNumber(reviewUrl) === prNumber);
}

function artifactMatchesTarget(task: TaskState, artifact: ReviewGateArtifact, prNumber: string | undefined, target: string): boolean {
  return reviewIdMatchesTarget(artifactReviewId(task, artifact), prNumber, target)
    || reviewUrlMatchesTarget(artifact.url, prNumber, target);
}

function taskMatchesTarget(task: TaskState, prNumber: string | undefined, target: string): boolean {
  return reviewIdMatchesTarget(task.execution.reviewId, prNumber, target)
    || reviewUrlMatchesTarget(task.execution.reviewUrl, prNumber, target)
    || (reviewGateForTask(task)?.artifacts ?? []).some((artifact) => artifactMatchesTarget(task, artifact, prNumber, target));
}

function taskIsRepairableReviewGate(task: TaskState): boolean {
  return task.status === 'review_ready' || task.status === 'awaiting_approval';
}

function isCurrentRequiredArtifact(gate: ReviewGateState, artifact: ReviewGateArtifact): boolean {
  return artifact.required === true
    && artifact.generation === gate.activeGeneration
    && artifact.status === 'open'
    && !artifact.discardedAt;
}

function normalizeFailedChecks(failedChecks: readonly ReviewGateFailedCheck[] | undefined): ReviewGateFailedCheck[] {
  return (failedChecks ?? []).map((check) => ({
    name: check.name,
    ...(check.conclusion ? { conclusion: check.conclusion } : {}),
    ...(check.detailsUrl ? { detailsUrl: check.detailsUrl } : {}),
  }));
}

function buildRecoveryEventKey(args: {
  workflowId: string;
  task: TaskState;
  reviewId: string;
  headSha?: string;
  failedChecks: readonly ReviewGateFailedCheck[];
}): string {
  return [
    'review_gate.ci_failed',
    `workflow:${args.workflowId}`,
    `task:${args.task.id}`,
    `generation:${args.task.execution.generation ?? 0}`,
    args.task.execution.selectedAttemptId ? `attempt:${args.task.execution.selectedAttemptId}` : undefined,
    args.task.taskStateVersion != null ? `task-state:${args.task.taskStateVersion}` : undefined,
    `recovery:${args.reviewId}:${args.headSha ?? 'no-head-sha'}:${ciFailureChecksHash(args.failedChecks)}`,
  ].filter((part): part is string => typeof part === 'string' && part.length > 0).join('|');
}

function findRepairArtifactForTask(
  task: TaskState,
  prNumber: string | undefined,
  target: string,
): { artifact?: ReviewGateArtifact; reason?: string; state?: 'not_available' | 'merge_conflict' } {
  const gate = reviewGateForTask(task);
  if (!gate) {
    return { reason: 'review-gate-artifacts-unavailable', state: 'not_available' };
  }

  const artifacts = (gate.artifacts ?? []).filter((artifact) => artifactMatchesTarget(task, artifact, prNumber, target));
  if (artifacts.length === 0) {
    return { reason: 'review-gate-artifact-unmatched', state: 'not_available' };
  }

  const current = artifacts.find((artifact) => isCurrentRequiredArtifact(gate, artifact));
  if (!current) {
    return { reason: 'review-gate-artifact-not-current', state: 'not_available' };
  }

  if (current.mergeState === 'dirty') {
    return { artifact: current, reason: 'merge-conflict', state: 'merge_conflict' };
  }
  if (current.checksState !== 'failure') {
    return { artifact: current, reason: current.checksState ? `checks-${current.checksState}` : 'checks-not-failed', state: 'not_available' };
  }
  if (normalizeFailedChecks(current.failedChecks).length === 0) {
    return { artifact: current, reason: 'failed-checks-missing', state: 'not_available' };
  }
  return { artifact: current };
}

function eventFromMappedTask(
  task: TaskState,
  artifact: ReviewGateArtifact,
  target: string,
  now: string,
): ReviewGateCiFailedLifecycleEvent | undefined {
  const workflowId = task.config.workflowId;
  const reviewId = artifact.providerId ?? task.execution.reviewId;
  if (!workflowId || !reviewId) return undefined;

  const failedChecks = normalizeFailedChecks(artifact.failedChecks);
  const generation = task.execution.generation ?? 0;
  const attemptId = task.execution.selectedAttemptId;
  const branch = task.execution.branch ?? artifact.branch;
  const eventKey = buildRecoveryEventKey({
    workflowId,
    task,
    reviewId,
    headSha: artifact.headSha,
    failedChecks,
  });
  return {
    eventKey,
    kind: 'review_gate.ci_failed',
    workflowId,
    taskId: task.id,
    status: task.status,
    taskStateVersion: task.taskStateVersion,
    generation,
    ...(attemptId ? { attemptId } : {}),
    createdAt: now,
    recoveryWakeup: {
      eventKey,
      eventKind: 'review_gate.ci_failed',
      workflowId,
      taskId: task.id,
      taskStateVersion: task.taskStateVersion,
      generation,
      ...(attemptId ? { attemptId } : {}),
      createdAt: now,
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId,
    reviewUrl: artifact.url ?? task.execution.reviewUrl ?? target,
    ...(artifact.headSha ? { headSha: artifact.headSha } : {}),
    ...(artifact.headRef ? { headRef: artifact.headRef } : {}),
    ...(branch ? { branch } : {}),
    failedChecks,
    statusText: artifact.rawStatus ?? task.execution.reviewStatus ?? 'CI failed',
  };
}

export function resolveReviewGateCiRepairTarget(
  target: string,
  options: Pick<ReviewGateQueryOptions, 'store'>,
): {
  target: string;
  prNumber?: string;
  workflow?: Workflow;
  task?: TaskState;
} {
  const normalizedTarget = target.trim();
  const prNumber = extractPrNumber(normalizedTarget);
  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    const task = tasks.find((candidate) =>
      candidate.config.isMergeNode && taskMatchesTarget(candidate, prNumber, normalizedTarget),
    );
    if (task) {
      const loadedWorkflow = options.store.loadWorkflow?.(workflow.id) ?? workflow as Workflow;
      return { target: normalizedTarget, prNumber, workflow: loadedWorkflow, task };
    }
  }
  return { target: normalizedTarget, prNumber };
}

function mappedResultBase(
  target: string,
  prNumber: string | undefined,
  workflow: Workflow | Pick<Workflow, 'id' | 'name'>,
  task: TaskState,
  event: ReviewGateCiFailedLifecycleEvent,
) {
  return {
    target,
    ...(prNumber ? { prNumber } : {}),
    workflowId: workflow.id,
    ...(workflow.name ? { workflowName: workflow.name } : {}),
    taskId: task.id,
    taskStatus: task.status,
    reviewId: event.reviewId,
    reviewUrl: event.reviewUrl,
    ...(event.headSha ? { headSha: event.headSha } : {}),
    failedChecks: [...event.failedChecks],
    actionKey: ciFailureActionKey(event),
  };
}

export async function runReviewGateCiRepairCommand(
  target: string,
  options: ReviewGateCiRepairCommandOptions,
): Promise<ReviewGateCiRepairCommandResult> {
  const resolved = resolveReviewGateCiRepairTarget(target, { store: options.store });
  if (!resolved.workflow || !resolved.task) {
    return {
      decision: 'unmapped',
      reason: 'no-matching-review-gate',
      target: resolved.target,
      ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
    };
  }

  const { workflow, task } = resolved;
  if (!taskIsRepairableReviewGate(task)) {
    return {
      decision: 'skipped',
      reason: 'status-not-repairable',
      target: resolved.target,
      ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
      workflowId: workflow.id,
      ...(workflow.name ? { workflowName: workflow.name } : {}),
      taskId: task.id,
      taskStatus: task.status,
      reviewId: task.execution.reviewId ?? resolved.prNumber ?? resolved.target,
      reviewUrl: task.execution.reviewUrl ?? resolved.target,
      failedChecks: [],
    };
  }

  const artifactResult = findRepairArtifactForTask(task, resolved.prNumber, resolved.target);
  if (!artifactResult.artifact || artifactResult.reason === 'merge-conflict') {
    return {
      decision: 'skipped',
      reason: artifactResult.reason ?? 'ci-failure-unavailable',
      target: resolved.target,
      ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
      workflowId: workflow.id,
      ...(workflow.name ? { workflowName: workflow.name } : {}),
      taskId: task.id,
      taskStatus: task.status,
      reviewId: artifactResult.artifact?.providerId ?? task.execution.reviewId ?? resolved.prNumber ?? resolved.target,
      reviewUrl: artifactResult.artifact?.url ?? task.execution.reviewUrl ?? resolved.target,
      ...(artifactResult.artifact?.headSha ? { headSha: artifactResult.artifact.headSha } : {}),
      failedChecks: normalizeFailedChecks(artifactResult.artifact?.failedChecks),
    };
  }

  const event = eventFromMappedTask(task, artifactResult.artifact, resolved.target, options.now?.() ?? new Date().toISOString());
  if (!event) {
    return {
      decision: 'skipped',
      reason: 'review-gate-event-unavailable',
      target: resolved.target,
      ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
      workflowId: workflow.id,
      ...(workflow.name ? { workflowName: workflow.name } : {}),
      taskId: task.id,
      taskStatus: task.status,
      reviewId: task.execution.reviewId ?? resolved.prNumber ?? resolved.target,
      reviewUrl: task.execution.reviewUrl ?? resolved.target,
      failedChecks: normalizeFailedChecks(artifactResult.artifact.failedChecks),
    };
  }

  const result: ReviewGateCiRepairResult = await queueReviewGateCiRepair({
    store: options.store,
    submitter: options.submitter,
    logger: options.logger,
    defaultAutoFixRetries: options.defaultAutoFixRetries ?? 1,
    getAutoFixAgent: options.getAutoFixAgent,
    getAutoFixExecutionModel: options.getAutoFixExecutionModel,
    attemptLedger: options.attemptLedger ?? commandAttemptLedger,
  }, event);

  return {
    decision: result.decision,
    reason: result.reason,
    ...mappedResultBase(resolved.target, resolved.prNumber, workflow, task, event),
    ...(result.intentId !== undefined ? { intentId: result.intentId } : {}),
  };
}

export function queryReviewGate(
  target: string,
  options: ReviewGateQueryOptions,
): ReviewGateQueryResult {
  const resolved = resolveReviewGateCiRepairTarget(target, options);
  if (!resolved.workflow || !resolved.task) {
    return {
      state: 'unmapped',
      target: resolved.target,
      ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
    };
  }

  const { workflow, task } = resolved;
  const base = {
    state: 'mapped' as const,
    target: resolved.target,
    ...(resolved.prNumber ? { prNumber: resolved.prNumber } : {}),
    workflowId: workflow.id,
    ...(workflow.name ? { workflowName: workflow.name } : {}),
    taskId: task.id,
    taskStatus: task.status,
    ...(task.execution.reviewId ? { reviewId: task.execution.reviewId } : {}),
    ...(task.execution.reviewUrl ? { reviewUrl: task.execution.reviewUrl } : {}),
  };

  if (!taskIsRepairableReviewGate(task)) {
    return {
      ...base,
      ciRepair: {
        state: 'not_available',
        reason: 'status-not-repairable',
      },
    };
  }

  const artifactResult = findRepairArtifactForTask(task, resolved.prNumber, resolved.target);
  if (!artifactResult.artifact) {
    return {
      ...base,
      ciRepair: {
        state: artifactResult.state ?? 'not_available',
        reason: artifactResult.reason ?? 'ci-failure-unavailable',
      },
    };
  }

  const event = artifactResult.reason === 'merge-conflict'
    ? undefined
    : eventFromMappedTask(task, artifactResult.artifact, resolved.target, new Date().toISOString());
  const actionKey = event ? ciFailureActionKey(event) : undefined;
  const action = actionKey ? options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, actionKey) : undefined;

  return {
    ...base,
    reviewId: artifactResult.artifact.providerId ?? task.execution.reviewId ?? base.reviewId,
    reviewUrl: artifactResult.artifact.url ?? task.execution.reviewUrl ?? base.reviewUrl,
    ciRepair: {
      state: artifactResult.state ?? (event ? 'available' : 'not_available'),
      ...(artifactResult.reason ? { reason: artifactResult.reason } : {}),
      ...(artifactResult.artifact.headSha ? { headSha: artifactResult.artifact.headSha } : {}),
      failedChecks: normalizeFailedChecks(artifactResult.artifact.failedChecks),
      ...(actionKey ? { actionKey } : {}),
      ...(action
        ? {
            action: {
              status: action.status,
              summary: action.summary,
              ...(action.intentId ? { intentId: action.intentId } : {}),
              ...(action.agentName ? { agentName: action.agentName } : {}),
              ...(action.executionModel ? { executionModel: action.executionModel } : {}),
              attemptCount: action.attemptCount,
              updatedAt: action.updatedAt,
              ...(action.completedAt ? { completedAt: action.completedAt } : {}),
            },
          }
        : {}),
    },
  };
}

export function formatReviewGateCiRepairResult(result: ReviewGateCiRepairCommandResult): string {
  if (result.decision === 'unmapped') {
    return `Review-gate CI repair unmapped for ${result.target}: no workflow review gate matched this PR.`;
  }

  const subject = `${result.reviewUrl} (workflow ${result.workflowId}, task ${result.taskId})`;
  if (result.decision === 'queued') {
    return `Review-gate CI repair queued for ${subject}: intent ${result.intentId ?? 'unknown'}.`;
  }
  return `Review-gate CI repair skipped for ${subject}: ${result.reason}.`;
}

export function formatReviewGateQueryResult(result: ReviewGateQueryResult): string {
  if (result.state === 'unmapped') {
    return `Review gate unmapped for ${result.target}`;
  }

  const lines = [
    `Review gate ${result.reviewUrl ?? result.reviewId ?? result.target}`,
    `  workflow: ${result.workflowId}${result.workflowName ? ` (${result.workflowName})` : ''}`,
    `  task: ${result.taskId} [${result.taskStatus}]`,
  ];
  if (result.ciRepair) {
    lines.push(`  ciRepair: ${result.ciRepair.state}${result.ciRepair.reason ? ` (${result.ciRepair.reason})` : ''}`);
    if (result.ciRepair.headSha) lines.push(`  headSha: ${result.ciRepair.headSha}`);
    if (result.ciRepair.failedChecks && result.ciRepair.failedChecks.length > 0) {
      lines.push(`  failedChecks: ${result.ciRepair.failedChecks.map((check) => check.name).join(', ')}`);
    }
    if (result.ciRepair.action) {
      lines.push(`  latestAction: ${result.ciRepair.action.status} - ${result.ciRepair.action.summary}`);
    }
  }
  return lines.join('\n');
}

type ReviewGateCiRepairCoordinator = {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: 'invoker:fix-with-agent',
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
};

export function createReviewGateCiRepairSubmitterFromCoordinator(
  coordinator: ReviewGateCiRepairCoordinator | null | undefined | (() => ReviewGateCiRepairCoordinator | null | undefined),
): ReviewGateCiRepairSubmitter {
  return {
    submit(workflowId, priority, channel, args, options) {
      const resolved = typeof coordinator === 'function' ? coordinator() : coordinator;
      if (!resolved) {
        throw new Error('Workflow mutation coordinator is unavailable for review-gate CI repair');
      }
      return resolved.submit(workflowId, priority, channel, args, options);
    },
  };
}

import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import {
  buildFixWithAgentMutationArgs,
  isReviewGateCiContextStale,
  listOpenFixIntentsForTask,
  type ReviewGateCiContext,
  type ReviewGateLineageFields,
} from './auto-fix-intents.js';
import {
  autoFixAttemptLedgerKeyFromLifecycleEvent,
  type AutoFixAttemptLedger,
} from './auto-fix-attempt-ledger.js';
import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';
import { checkAutoFixRetryCap, recordAutoFixRetryConsumed } from './auto-fix-retry-cap.js';
import type {
  ReviewGateCiFailedLifecycleEvent,
  ReviewGateFailedCheck,
} from './lifecycle-events.js';
import { recordWorkerDecisionRow } from './worker-decision-ledger.js';

const CI_FAILURE_WORKER_KIND = 'ci-failure';
const FIX_WITH_AGENT_CHANNEL = 'invoker:fix-with-agent';
const CI_FAILURE_ACTION_TYPE = 'fix-ci-failure';
const NO_HEAD_SHA = 'no-head';

type CiFailureActionStatus = WorkerActionStatus;

export interface ReviewGateCiRepairStore {
  listWorkflows?(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface ReviewGateCiRepairSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof FIX_WITH_AGENT_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface ReviewGateCiRepairPolicyOptions {
  store: ReviewGateCiRepairStore;
  submitter: ReviewGateCiRepairSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  attemptLedger: AutoFixAttemptLedger;
  getRetryBudget?: (task: TaskState) => number;
}

type ReviewGateArtifact = NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number];

export function ciFailureChecksHash(failedChecks: readonly ReviewGateFailedCheck[]): string {
  const normalized = failedChecks
    .map((check) => ({
      name: check.name,
      conclusion: check.conclusion ?? '',
      detailsUrl: check.detailsUrl ?? '',
    }))
    .sort((a, b) =>
      a.name.localeCompare(b.name)
      || a.conclusion.localeCompare(b.conclusion)
      || a.detailsUrl.localeCompare(b.detailsUrl),
    );
  return createHash('sha256')
    .update(JSON.stringify(normalized))
    .digest('hex');
}

export function ciFailureActionKey(event: Pick<
  ReviewGateCiFailedLifecycleEvent,
  'taskId' | 'reviewId' | 'headSha' | 'failedChecks'
>): string {
  return [
    'ci-failure',
    event.taskId,
    event.reviewId,
    event.headSha ?? NO_HEAD_SHA,
    ciFailureChecksHash(event.failedChecks),
  ].join(':');
}

function isCurrentRequiredReviewGateArtifact(
  gate: NonNullable<TaskState['execution']['reviewGate']>,
  artifact: ReviewGateArtifact,
): boolean {
  return artifact.required
    && artifact.generation === gate.activeGeneration
    && artifact.status === 'open'
    && !artifact.discardedAt;
}

function normalizeFailedChecks(
  failedChecks: ReviewGateArtifact['failedChecks'],
): ReviewGateFailedCheck[] {
  return (failedChecks ?? []).map((check) => ({
    name: check.name,
    conclusion: check.conclusion,
    detailsUrl: check.detailsUrl,
  }));
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId;
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

function reviewGateCiRecoveryEventFromArtifact(
  task: TaskState,
  artifact: ReviewGateArtifact,
  now: string,
): ReviewGateCiFailedLifecycleEvent | undefined {
  const gate = task.execution.reviewGate;
  const workflowId = workflowIdForTask(task);
  const reviewId = artifact.providerId ?? task.execution.reviewId;
  if (!gate || !workflowId || !reviewId) return undefined;
  if (!isCurrentRequiredReviewGateArtifact(gate, artifact)) return undefined;
  if (artifact.mergeState === 'dirty') return undefined;
  if (artifact.checksState !== 'failure') return undefined;

  const failedChecks = normalizeFailedChecks(artifact.failedChecks);
  if (failedChecks.length === 0) return undefined;

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
    reviewUrl: artifact.url ?? reviewId,
    ...(artifact.headSha ? { headSha: artifact.headSha } : {}),
    ...(artifact.headRef ? { headRef: artifact.headRef } : {}),
    ...(branch ? { branch } : {}),
    failedChecks,
    statusText: artifact.rawStatus ?? 'CI failed',
  };
}

export function listReviewGateCiRepairRecoveryEvents(
  options: Pick<ReviewGateCiRepairPolicyOptions, 'store' | 'logger'> & { now?: () => string },
): ReviewGateCiFailedLifecycleEvent[] {
  const listWorkflows = options.store.listWorkflows;
  if (!listWorkflows) {
    options.logger.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-scan-skip`, {
      module: 'review-gate-ci-repair',
      reason: 'list-workflows-unavailable',
    });
    return [];
  }

  const events: ReviewGateCiFailedLifecycleEvent[] = [];
  let workflows: ReadonlyArray<{ id: string }>;
  try {
    workflows = listWorkflows.call(options.store);
  } catch (error) {
    options.logger.error(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-scan-error`, {
      module: 'review-gate-ci-repair',
      phase: 'list-workflows',
      error: error instanceof Error ? error.message : String(error),
    });
    return events;
  }

  for (const workflow of workflows) {
    let tasks: TaskState[];
    try {
      tasks = options.store.loadTasks(workflow.id);
    } catch (error) {
      options.logger.error(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-scan-error`, {
        module: 'review-gate-ci-repair',
        workflowId: workflow.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const task of tasks) {
      if (!task.config.isMergeNode) continue;
      if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') continue;
      const gate = task.execution.reviewGate;
      if (!gate) continue;
      for (const artifact of gate.artifacts) {
        const event = reviewGateCiRecoveryEventFromArtifact(
          task,
          artifact,
          options.now?.() ?? new Date().toISOString(),
        );
        if (event) events.push(event);
      }
    }
  }
  return events;
}

function retryBudgetForTask(task: TaskState, options: ReviewGateCiRepairPolicyOptions): number {
  return normalizeAutoFixRetryBudget(options.getRetryBudget?.(task) ?? options.defaultAutoFixRetries ?? 0);
}

function retryBudgetLabel(budget: number): number | 'unlimited' {
  return budget === Number.POSITIVE_INFINITY ? 'unlimited' : budget;
}

function loadTaskForEvent(
  event: ReviewGateCiFailedLifecycleEvent,
  options: ReviewGateCiRepairPolicyOptions,
): TaskState | undefined {
  const direct = options.store.loadTask?.(event.taskId);
  if (direct) return direct;
  return options.store.loadTasks(event.workflowId).find((task) => task.id === event.taskId);
}

function currentReviewGateLineage(
  task: TaskState,
  reviewId: string,
): ReviewGateLineageFields {
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

function reviewGateContextFromEvent(event: ReviewGateCiFailedLifecycleEvent): ReviewGateCiContext {
  return {
    reviewId: event.reviewId,
    generation: event.generation,
    selectedAttemptId: event.attemptId,
    branch: event.branch,
    headSha: event.headSha,
    fixContext: buildCiFailureFixContext(event),
  };
}

function staleReasonForEvent(
  event: ReviewGateCiFailedLifecycleEvent,
  task: TaskState,
): { stale: false } | { stale: true; reason: string; details: Record<string, unknown> } {
  if (task.config.workflowId !== event.workflowId) {
    return {
      stale: true,
      reason: 'workflow-changed',
      details: { currentWorkflowId: task.config.workflowId ?? null },
    };
  }
  if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') {
    return {
      stale: true,
      reason: 'status-changed',
      details: { currentStatus: task.status },
    };
  }

  const context = reviewGateContextFromEvent(event);
  const current = currentReviewGateLineage(task, event.reviewId);
  if (!isReviewGateCiContextStale(context, current)) {
    return { stale: false };
  }

  if (current.reviewId !== event.reviewId) {
    return {
      stale: true,
      reason: 'review-changed',
      details: { currentReviewId: current.reviewId ?? null },
    };
  }
  if ((current.generation ?? 0) !== event.generation) {
    return {
      stale: true,
      reason: 'generation-changed',
      details: { currentGeneration: current.generation ?? 0 },
    };
  }
  if (current.selectedAttemptId !== event.attemptId) {
    return {
      stale: true,
      reason: 'selected-attempt-changed',
      details: { currentSelectedAttemptId: current.selectedAttemptId ?? null },
    };
  }
  if (current.headSha !== event.headSha) {
    return {
      stale: true,
      reason: 'head-sha-changed',
      details: { currentHeadSha: current.headSha ?? null },
    };
  }
  return {
    stale: true,
    reason: 'branch-changed',
    details: { currentBranch: current.branch ?? null },
  };
}

function isOpenOrCompletedActionStatus(status: string): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'completed';
}

function recordCiFailureAction(
  options: ReviewGateCiRepairPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  status: CiFailureActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
  agentName?: string,
  executionModel?: string,
): WorkerActionRecord | undefined {
  if (!options.store.upsertWorkerAction) return undefined;
  return recordWorkerDecisionRow(options.store, {
    workerKind: CI_FAILURE_WORKER_KIND,
    actionType: CI_FAILURE_ACTION_TYPE,
    externalKey: ciFailureActionKey(event),
    subjectType: 'review',
    subjectId: event.reviewId,
    workflowId: event.workflowId,
    taskId: event.taskId,
    status,
    summary,
    incrementAttempt: status === 'queued',
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    ...(agentName ? { agentName } : {}),
    ...(executionModel ? { executionModel } : {}),
    payload: {
      reviewUrl: event.reviewUrl,
      headSha: event.headSha ?? null,
      headRef: event.headRef ?? null,
      branch: event.branch ?? null,
      statusText: event.statusText,
      generation: event.generation,
      selectedAttemptId: event.attemptId ?? null,
      taskStateVersion: event.taskStateVersion ?? null,
      failedChecksHash: ciFailureChecksHash(event.failedChecks),
      failedChecks: event.failedChecks.map((check) => ({ ...check })),
      ...payload,
    },
  });
}

function logCiFailureWorkerEvent(
  options: ReviewGateCiRepairPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = {
    reviewId: event.reviewId,
    reviewUrl: event.reviewUrl,
    workflowId: event.workflowId,
    taskId: event.taskId,
    generation: event.generation,
    selectedAttemptId: event.attemptId ?? null,
    failedChecksHash: ciFailureChecksHash(event.failedChecks),
    ...details,
  };
  options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', payload);
  options.logger.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] ${phase}`, {
    module: 'review-gate-ci-repair',
    ...payload,
  });
}


function buildCiFailureFixContext(event: ReviewGateCiFailedLifecycleEvent): string {
  const checks = event.failedChecks
    .map((check) => {
      const conclusion = check.conclusion ? ` (${check.conclusion})` : '';
      const details = check.detailsUrl ? ` - ${check.detailsUrl}` : '';
      return `- ${check.name}${conclusion}${details}`;
    })
    .join('\n');
  return [
    `Review-gate CI failed for ${event.reviewUrl}.`,
    `Head SHA: ${event.headSha ?? 'unknown'}.`,
    `Status: ${event.statusText}.`,
    'Failed checks:',
    checks,
  ].join('\n');
}

function shouldSkipExistingAction(
  options: ReviewGateCiRepairPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): boolean {
  const externalKey = ciFailureActionKey(event);
  const existing = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, externalKey);
  if (!existing) return false;
  if (isOpenOrCompletedActionStatus(existing.status)) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'already-recorded',
      existingStatus: existing.status,
      intentId: existing.intentId ?? null,
    });
    return true;
  }
  return false;
}

function firstLine(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.split('\n', 1)[0];
}

function reconcileFinishedIntentAction(
  options: ReviewGateCiRepairPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): void {
  const externalKey = ciFailureActionKey(event);
  const existing = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, externalKey);
  if (!existing || !existing.intentId) return;
  if (existing.status !== 'queued' && existing.status !== 'pending' && existing.status !== 'running') return;

  const terminalIntents = options.store.listWorkflowMutationIntents?.(event.workflowId, ['completed', 'failed']) ?? [];
  const intent = terminalIntents.find((candidate) => String(candidate.id) === existing.intentId);
  if (!intent) return;

  const now = new Date().toISOString();
  const status: WorkerActionStatus = intent.status === 'completed' ? 'completed' : 'failed';
  const summary = status === 'completed'
    ? 'CI repair intent completed'
    : `CI repair intent failed: ${firstLine(intent.error) ?? 'unknown error'}`;
  const payload = existing.payload && typeof existing.payload === 'object'
    ? { ...(existing.payload as Record<string, unknown>) }
    : {};
  options.store.upsertWorkerAction?.({
    ...existing,
    status,
    summary,
    payload: {
      ...payload,
      reconciledIntentStatus: intent.status,
      intentError: intent.error ?? null,
    },
    updatedAt: now,
    completedAt: now,
  });
  logCiFailureWorkerEvent(options, event, 'worker-ci-failure-intent-reconciled', {
    intentId: existing.intentId,
    intentStatus: intent.status,
    actionStatus: status,
  });
}
export interface ReviewGateCiRepairResult {
  decision: 'queued' | 'skipped';
  reason: string;
  intentId?: number;
}

export async function queueReviewGateCiRepair(
  options: ReviewGateCiRepairPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): Promise<ReviewGateCiRepairResult> {
  const task = loadTaskForEvent(event, options);
  if (!task) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: 'task-missing' });
    return { decision: 'skipped', reason: 'task-missing' };
  }

  reconcileFinishedIntentAction(options, event);
  if (shouldSkipExistingAction(options, event)) {
    return { decision: 'skipped', reason: 'already-recorded' };
  }

  const openFixIntents = listOpenFixIntentsForTask(
    options.store.listWorkflowMutationIntents?.(event.workflowId, ['queued', 'running']) ?? [],
    event.taskId,
  );
  if (openFixIntents.length > 0) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'fix-intent-open',
      openIntentIds: openFixIntents.map((intent) => String(intent.id)),
    });
    return { decision: 'skipped', reason: 'fix-intent-open' };
  }

  const stale = staleReasonForEvent(event, task);
  if (stale.stale) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: stale.reason, ...stale.details });
    return { decision: 'skipped', reason: stale.reason };
  }

  const workerRetryBudget = retryBudgetForTask(task, options);
  const retryCap = checkAutoFixRetryCap(options.store, event.taskId, workerRetryBudget);
  if (!retryCap.allowed) {
    recordCiFailureAction(options, event, 'skipped', 'Skipped CI repair because retry budget is exhausted', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    });
    return { decision: 'skipped', reason: 'worker-retry-budget-exhausted' };
  }

  const attemptDecision = options.attemptLedger.consume(
    autoFixAttemptLedgerKeyFromLifecycleEvent(event),
    workerRetryBudget,
  );
  if (!attemptDecision.allowed) {
    const summary = attemptDecision.reason === 'worker-retry-budget-disabled'
      ? 'Skipped CI repair because retry budget is disabled'
      : 'Skipped CI repair because retry budget is exhausted';
    recordCiFailureAction(options, event, 'skipped', summary, {
      reason: attemptDecision.reason,
      workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: attemptDecision.reason,
      workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
    });
    return { decision: 'skipped', reason: attemptDecision.reason };
  }

  const configuredAgent = options.getAutoFixAgent?.()?.trim();
  const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
  options.logger.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-attempt-consumed`, {
    module: 'review-gate-ci-repair',
    taskId: event.taskId,
    workflowId: event.workflowId,
    generation: event.generation,
    attemptId: event.attemptId ?? null,
    attemptsBefore: attemptDecision.attemptsBefore,
    attemptsAfter: attemptDecision.attemptsAfter,
    workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
  });
  const configuredExecutionModel = options.getAutoFixExecutionModel?.()?.trim();
  const executionModel = configuredExecutionModel && configuredExecutionModel.length > 0
    ? configuredExecutionModel
    : undefined;
  const args = buildFixWithAgentMutationArgs(event.taskId, selectedAgent, {
    autoFix: true,
    reviewGateContext: {
      reviewId: event.reviewId,
      generation: event.generation,
      selectedAttemptId: event.attemptId,
      branch: event.branch,
      headSha: event.headSha,
      fixContext: buildCiFailureFixContext(event),
    },
    executionModel,
  });
  const intentId = options.submitter.submit(event.workflowId, 'normal', FIX_WITH_AGENT_CHANNEL, args);
  recordCiFailureAction(
    options,
    event,
    'queued',
    'Queued CI repair with agent',
    {
      channel: FIX_WITH_AGENT_CHANNEL,
      workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
    },
    intentId,
    selectedAgent,
    executionModel,
  );
  logCiFailureWorkerEvent(options, event, 'worker-ci-failure-submitted', {
    intentId,
    channel: FIX_WITH_AGENT_CHANNEL,
    agent: selectedAgent ?? null,
    executionModel: executionModel ?? null,
    workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
  });
  recordAutoFixRetryConsumed(options.store, event.taskId, { workflowId: event.workflowId });
  return { decision: 'queued', reason: 'queued', intentId };
}

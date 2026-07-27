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
import {
  classifyFailedChecks,
  type FailedCheckLogFetcher,
} from './ci-failure-infra-classifier.js';
import { recordWorkerDecisionRow } from './worker-decision-ledger.js';
import type { StackPrRecord } from './pr-stack-detection.js';

const CI_FAILURE_WORKER_KIND = 'ci-failure';
export const SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL = 'invoker:spawn-review-gate-ci-repair';
export const SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL = 'invoker:spawn-review-gate-stack-ci-repair';
const CI_FAILURE_ACTION_TYPE = 'fix-ci-failure';
const CI_FAILURE_STACK_ACTION_TYPE = 'fix-ci-failure-stack';
const NO_HEAD_SHA = 'no-head';

/** A stack detection result scoped to one lifecycle event's PR. Kept as its
 *  own shape here (rather than importing pr-stack-detection.ts's detectStack
 *  function) so this policy module only depends on the data shape, not the
 *  live-gh-fetch half of stack detection. */
export interface StackRepairCandidate {
  readonly stackId: string;
  readonly members: readonly StackPrRecord[];
}

type CiFailureActionStatus = WorkerActionStatus;

export interface ReviewGateCiRepairStore {
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
    channel: typeof SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL | typeof SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL,
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
  /** Optional failed-check log fetcher used to skip non-fixable infra failures. */
  fetchFailedCheckLogs?: FailedCheckLogFetcher;
  /** Stack-batched CI repair (default off). When enabled and the failing PR
   *  turns out to have stack-mates, the whole stack is repaired as one batch
   *  instead of firing a single-PR plan. See detectStackForEvent below. */
  isStackRepairEnabled?: () => boolean;
  /** Resolves the failing PR's stack membership, if any. Returning undefined
   *  or a single-member stack falls back to today's single-PR behavior. Kept
   *  injectable (rather than calling pr-stack-detection.ts's live fetch
   *  directly) so this stays unit-testable with no `gh` calls. */
  detectStackForEvent?: (
    event: ReviewGateCiFailedLifecycleEvent,
  ) => Promise<StackRepairCandidate | undefined>;
}

export interface ReviewGateCiRepairWorkflowMutationArgs {
  readonly sourceWorkflowId: string;
  readonly sourceTaskId: string;
  readonly reviewId: string;
  readonly reviewUrl: string;
  readonly headSha?: string;
  readonly headRef?: string;
  readonly branch?: string;
  readonly generation: number;
  readonly selectedAttemptId?: string;
  readonly failedChecks: readonly ReviewGateFailedCheck[];
  readonly statusText: string;
  readonly taskStateVersion: number;
  readonly agentName?: string;
  readonly executionModel?: string;
}

export function buildReviewGateCiRepairWorkflowMutationArgs(
  payload: ReviewGateCiRepairWorkflowMutationArgs,
): unknown[] {
  return [payload];
}

export function parseReviewGateCiRepairWorkflowMutationArgs(args: unknown[]): ReviewGateCiRepairWorkflowMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object') {
    throw new Error('invoker:spawn-review-gate-ci-repair mutation requires an argument object');
  }
  const candidate = raw as Record<string, unknown>;
  const {
    sourceWorkflowId,
    sourceTaskId,
    reviewId,
    reviewUrl,
    headSha,
    headRef,
    branch,
    generation,
    selectedAttemptId,
    failedChecks,
    statusText,
    taskStateVersion,
    agentName,
    executionModel,
  } = candidate;
  if (
    typeof sourceWorkflowId !== 'string'
    || typeof sourceTaskId !== 'string'
    || typeof reviewId !== 'string'
    || typeof reviewUrl !== 'string'
    || typeof generation !== 'number'
    || !Array.isArray(failedChecks)
    || typeof statusText !== 'string'
    || typeof taskStateVersion !== 'number'
  ) {
    throw new Error(
      'invoker:spawn-review-gate-ci-repair mutation requires { sourceWorkflowId, sourceTaskId, reviewId, reviewUrl, generation, failedChecks, statusText, taskStateVersion }',
    );
  }
  return {
    sourceWorkflowId,
    sourceTaskId,
    reviewId,
    reviewUrl,
    ...(typeof headSha === 'string' ? { headSha } : {}),
    ...(typeof headRef === 'string' ? { headRef } : {}),
    ...(typeof branch === 'string' ? { branch } : {}),
    generation,
    ...(typeof selectedAttemptId === 'string' ? { selectedAttemptId } : {}),
    failedChecks: failedChecks.map((check) => ({ ...(check as ReviewGateFailedCheck) })),
    statusText,
    taskStateVersion,
    ...(typeof agentName === 'string' ? { agentName } : {}),
    ...(typeof executionModel === 'string' ? { executionModel } : {}),
  };
}

export interface ReviewGateStackCiRepairWorkflowMutationArgs {
  readonly stackId: string;
  readonly members: readonly StackPrRecord[];
  readonly triggering: ReviewGateCiRepairWorkflowMutationArgs;
}

export function buildReviewGateStackCiRepairWorkflowMutationArgs(
  payload: ReviewGateStackCiRepairWorkflowMutationArgs,
): unknown[] {
  return [payload];
}

function isStackPrRecord(value: unknown): value is StackPrRecord {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.number === 'number'
    && typeof candidate.state === 'string'
    && typeof candidate.baseRefName === 'string'
    && typeof candidate.headRefName === 'string'
    && typeof candidate.headRefOid === 'string';
}

export function parseReviewGateStackCiRepairWorkflowMutationArgs(
  args: unknown[],
): ReviewGateStackCiRepairWorkflowMutationArgs {
  const [raw] = args;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`${SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL} mutation requires an argument object`);
  }
  const candidate = raw as Record<string, unknown>;
  const { stackId, members, triggering } = candidate;
  if (
    typeof stackId !== 'string'
    || !Array.isArray(members)
    || members.length === 0
    || !members.every(isStackPrRecord)
    || !triggering
    || typeof triggering !== 'object'
  ) {
    throw new Error(
      `${SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL} mutation requires { stackId, members: StackPrRecord[], triggering }`,
    );
  }
  return {
    stackId,
    members: members.map((member) => ({ ...(member as StackPrRecord) })),
    triggering: parseReviewGateCiRepairWorkflowMutationArgs([triggering]),
  };
}

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

/** Dedup key for a whole stack's in-flight repair, not a single PR/check —
 *  sorted PR-number+headSha pairs so ANY member's later CI-failure event
 *  (not just the one that originally triggered the batch) resolves to the
 *  same key and correctly finds the in-flight record. */
export function stackCiFailureActionKey(candidate: StackRepairCandidate): string {
  const memberKey = [...candidate.members]
    .sort((a, b) => a.number - b.number)
    .map((member) => `${member.number}@${member.headRefOid}`)
    .join(',');
  return ['ci-failure-stack', candidate.stackId, memberKey].join(':');
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

  if (options.fetchFailedCheckLogs) {
    let logsByDetailsUrl = new Map<string, string>();
    try {
      logsByDetailsUrl = await options.fetchFailedCheckLogs(event.failedChecks);
    } catch (error) {
      logCiFailureWorkerEvent(options, event, 'worker-ci-failure-infra-classify-error', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    const classified = classifyFailedChecks(event.failedChecks, logsByDetailsUrl);
    if (classified.classification === 'infra') {
      recordCiFailureAction(
        options,
        event,
        'skipped',
        'Skipped CI repair because failure looks like runner/infra',
        {
          reason: 'infra-failure',
          matchedSignals: [...classified.matchedSignals],
          classifiedCheckCount: classified.classifiedCheckCount,
        },
      );
      logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
        reason: 'infra-failure',
        matchedSignals: [...classified.matchedSignals],
        classifiedCheckCount: classified.classifiedCheckCount,
      });
      return { decision: 'skipped', reason: 'infra-failure' };
    }
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
  const singlePrPayload: ReviewGateCiRepairWorkflowMutationArgs = {
    sourceWorkflowId: event.workflowId,
    sourceTaskId: event.taskId,
    reviewId: event.reviewId,
    reviewUrl: event.reviewUrl,
    ...(event.headSha ? { headSha: event.headSha } : {}),
    ...(event.headRef ? { headRef: event.headRef } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
    generation: event.generation,
    ...(event.attemptId ? { selectedAttemptId: event.attemptId } : {}),
    failedChecks: event.failedChecks.map((check) => ({ ...check })),
    statusText: event.statusText,
    taskStateVersion: event.taskStateVersion ?? task.taskStateVersion,
    ...(selectedAgent ? { agentName: selectedAgent } : {}),
    ...(executionModel ? { executionModel } : {}),
  };

  if (options.isStackRepairEnabled?.() && options.detectStackForEvent) {
    const candidate = await options.detectStackForEvent(event);
    if (candidate && candidate.members.length > 1) {
      const stackKey = stackCiFailureActionKey(candidate);
      const existingStackAction = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, stackKey);
      if (existingStackAction && isOpenOrCompletedActionStatus(existingStackAction.status)) {
        logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
          reason: 'stack-repair-in-flight',
          stackId: candidate.stackId,
          existingStatus: existingStackAction.status,
        });
        return { decision: 'skipped', reason: 'stack-repair-in-flight' };
      }

      const stackArgs = buildReviewGateStackCiRepairWorkflowMutationArgs({
        stackId: candidate.stackId,
        members: candidate.members,
        triggering: singlePrPayload,
      });
      const stackIntentId = options.submitter.submit(
        event.workflowId,
        'normal',
        SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL,
        stackArgs,
      );
      recordWorkerDecisionRow(options.store, {
        workerKind: CI_FAILURE_WORKER_KIND,
        actionType: CI_FAILURE_STACK_ACTION_TYPE,
        externalKey: stackKey,
        subjectType: 'pr-stack',
        subjectId: candidate.stackId,
        workflowId: event.workflowId,
        taskId: event.taskId,
        status: 'queued',
        summary: `Queued stack CI repair for ${candidate.members.length} PR(s)`,
        incrementAttempt: true,
        intentId: stackIntentId,
        ...(selectedAgent ? { agentName: selectedAgent } : {}),
        ...(executionModel ? { executionModel } : {}),
        payload: {
          channel: SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL,
          members: candidate.members.map((member) => member.number),
          workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
        },
      });
      logCiFailureWorkerEvent(options, event, 'worker-ci-failure-submitted', {
        intentId: stackIntentId,
        channel: SPAWN_REVIEW_GATE_STACK_CI_REPAIR_CHANNEL,
        stackId: candidate.stackId,
        members: candidate.members.map((member) => member.number),
        agent: selectedAgent ?? null,
        executionModel: executionModel ?? null,
      });
      recordAutoFixRetryConsumed(options.store, event.taskId, { workflowId: event.workflowId });
      return { decision: 'queued', reason: 'queued', intentId: stackIntentId };
    }
  }

  const args = buildReviewGateCiRepairWorkflowMutationArgs(singlePrPayload);
  const intentId = options.submitter.submit(
    event.workflowId,
    'normal',
    SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
    args,
  );
  recordCiFailureAction(
    options,
    event,
    'queued',
    'Queued CI repair workflow',
    {
      channel: SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
      workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
    },
    intentId,
    selectedAgent,
    executionModel,
  );
  logCiFailureWorkerEvent(options, event, 'worker-ci-failure-submitted', {
    intentId,
    channel: SPAWN_REVIEW_GATE_CI_REPAIR_CHANNEL,
    agent: selectedAgent ?? null,
    executionModel: executionModel ?? null,
    workerRetryBudget: retryBudgetLabel(attemptDecision.workerRetryBudget),
  });
  recordAutoFixRetryConsumed(options.store, event.taskId, { workflowId: event.workflowId });
  return { decision: 'queued', reason: 'queued', intentId };
}

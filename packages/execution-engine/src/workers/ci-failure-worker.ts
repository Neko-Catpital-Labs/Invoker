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
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';

import {
  buildFixWithAgentMutationArgs,
  isReviewGateCiContextStale,
  listOpenFixIntentsForTask,
  type ReviewGateCiContext,
  type ReviewGateLineageFields,
} from '../auto-fix-intents.js';
import { normalizeAutoFixRetryBudget } from '../auto-fix-gating.js';
import type {
  ReviewGateCiFailedLifecycleEvent,
  ReviewGateFailedCheck,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CI_FAILURE_WORKER_KIND = 'ci-failure';
export const DEFAULT_CI_FAILURE_WORKER_INTERVAL_MS = 60_000;

const FIX_WITH_AGENT_CHANNEL = 'invoker:fix-with-agent';
const CI_FAILURE_ACTION_TYPE = 'fix-ci-failure';
const NO_HEAD_SHA = 'no-head';

type CiFailureActionStatus = WorkerActionStatus;

export interface CiFailureWorkerStore {
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

export interface CiFailureWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof FIX_WITH_AGENT_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface CiFailureWorkerPolicyOptions {
  store: CiFailureWorkerStore;
  submitter: CiFailureWorkerSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  drainEvents?: () => ReviewGateCiFailedLifecycleEvent[];
}

export interface CiFailureWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  ciFailure?: Omit<CiFailureWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  onTick?: WorkerTick;
}
/** Register the built-in CI-failure repair worker. */
export function registerCiFailureWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CI_FAILURE_WORKER_KIND,
    note: 'Submits head-SHA guarded CI repair intents for failed review-gate checks.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCiFailureWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        ciFailure: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          getAutoFixExecutionModel: deps.autoFix?.getAutoFixExecutionModel,
        },
      }),
  });
  return registry;
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

function retryBudgetForWorker(options: CiFailureWorkerPolicyOptions): number {
  return normalizeAutoFixRetryBudget(options.defaultAutoFixRetries ?? 0);
}

function retryBudgetLabel(budget: number): number | 'unlimited' {
  return budget === Number.POSITIVE_INFINITY ? 'unlimited' : budget;
}

function loadTaskForEvent(
  event: ReviewGateCiFailedLifecycleEvent,
  options: CiFailureWorkerPolicyOptions,
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

function actionIdForKey(externalKey: string): string {
  return `${CI_FAILURE_WORKER_KIND}:${externalKey}`;
}

function isOpenOrCompletedActionStatus(status: string): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'completed';
}

function coerceActionStatus(status: CiFailureActionStatus): WorkerActionStatus {
  return status;
}

function recordCiFailureAction(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  status: CiFailureActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
  agentName?: string,
  executionModel?: string,
): WorkerActionRecord | undefined {
  const externalKey = ciFailureActionKey(event);
  const existing = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  return options.store.upsertWorkerAction?.({
    id: existing?.id ?? actionIdForKey(externalKey),
    workerKind: CI_FAILURE_WORKER_KIND,
    actionType: CI_FAILURE_ACTION_TYPE,
    workflowId: event.workflowId,
    taskId: event.taskId,
    subjectType: 'review',
    subjectId: event.reviewId,
    externalKey,
    status: coerceActionStatus(status),
    attemptCount: status === 'queued' || status === 'failed'
      ? (existing?.attemptCount ?? 0) + 1
      : existing?.attemptCount ?? 0,
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    agentName,
    executionModel,
    summary,
    payload: {
      reviewId: event.reviewId,
      reviewUrl: event.reviewUrl,
      headSha: event.headSha ?? null,
      headRef: event.headRef ?? null,
      branch: event.branch ?? null,
      generation: event.generation,
      selectedAttemptId: event.attemptId ?? null,
      taskStateVersion: event.taskStateVersion ?? null,
      failedChecksHash: ciFailureChecksHash(event.failedChecks),
      failedChecks: event.failedChecks.map((check) => ({ ...check })),
      ...payload,
    },
    updatedAt: now,
    ...(status === 'skipped' || status === 'failed' || status === 'completed' ? { completedAt: now } : {}),
  });
}

function logCiFailureWorkerEvent(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = {
    phase,
    worker: CI_FAILURE_WORKER_KIND,
    workflowId: event.workflowId,
    reviewId: event.reviewId,
    headSha: event.headSha ?? null,
    generation: event.generation,
    selectedAttemptId: event.attemptId ?? null,
    failedChecksHash: ciFailureChecksHash(event.failedChecks),
    ...details,
  };
  options.store.logEvent?.(event.taskId, 'debug.ci-failure-worker', payload);
  options.logger.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] ${phase}`, {
    module: 'ci-failure-worker',
    taskId: event.taskId,
    ...payload,
  });
}

function listOpenFixIntentsForEvent(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): WorkflowMutationIntent[] {
  const open = options.store.listWorkflowMutationIntents?.(event.workflowId, ['queued', 'running']) ?? [];
  return listOpenFixIntentsForTask(open, event.taskId);
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
  options: CiFailureWorkerPolicyOptions,
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

async function handleCiFailureEvent(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): Promise<void> {
  const task = loadTaskForEvent(event, options);
  if (!task) {
    recordCiFailureAction(options, event, 'skipped', 'Skipped CI repair because task no longer exists', {
      reason: 'task-not-found',
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: 'task-not-found' });
    return;
  }

  const workerRetryBudget = retryBudgetForWorker(options);
  if (workerRetryBudget <= 0) {
    recordCiFailureAction(options, event, 'skipped', 'Skipped CI repair because worker retry budget is disabled', {
      reason: 'worker-retry-budget-disabled',
      workerRetryBudget,
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'worker-retry-budget-disabled',
      workerRetryBudget,
    });
    return;
  }

  if (shouldSkipExistingAction(options, event)) return;

  const stale = staleReasonForEvent(event, task);
  if (stale.stale) {
    recordCiFailureAction(options, event, 'skipped', `Skipped stale CI repair: ${stale.reason}`, {
      reason: stale.reason,
      ...stale.details,
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-stale', {
      reason: stale.reason,
      ...stale.details,
    });
    return;
  }

  if ((task.execution.autoFixAttempts ?? 0) >= workerRetryBudget) {
    recordCiFailureAction(options, event, 'skipped', 'Skipped CI repair because worker retry budget is exhausted', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(workerRetryBudget),
      autoFixAttempts: task.execution.autoFixAttempts ?? 0,
    });
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(workerRetryBudget),
      autoFixAttempts: task.execution.autoFixAttempts ?? 0,
    });
    return;
  }

  const openFixIntents = listOpenFixIntentsForEvent(options, event);
  if (openFixIntents.length > 0) {
    const intentId = openFixIntents[0]?.id;
    recordCiFailureAction(options, event, 'queued', 'CI repair already queued for task', {
      reason: 'already-queued-intent',
      existingIntentIds: openFixIntents.map((intent) => intent.id),
    }, intentId);
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'already-queued-intent',
      existingIntentIds: openFixIntents.map((intent) => intent.id),
    });
    return;
  }

  const configuredAgent = options.getAutoFixAgent?.()?.trim();
  const selectedAgent = configuredAgent && configuredAgent.length > 0 ? configuredAgent : undefined;
  const configuredExecutionModel = options.getAutoFixExecutionModel?.()?.trim();
  const executionModel = configuredExecutionModel && configuredExecutionModel.length > 0
    ? configuredExecutionModel
    : undefined;
  const args = buildFixWithAgentMutationArgs(event.taskId, selectedAgent, {
    autoFix: true,
    reviewGateContext: reviewGateContextFromEvent(event),
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
      autoFixAttempts: task.execution.autoFixAttempts ?? 0,
      workerRetryBudget: retryBudgetLabel(workerRetryBudget),
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
    autoFixAttempts: task.execution.autoFixAttempts ?? 0,
    workerRetryBudget: retryBudgetLabel(workerRetryBudget),
  });
}

export function createCiFailureTick(options: CiFailureWorkerPolicyOptions): WorkerTick {
  return async () => {
    const events = options.drainEvents?.() ?? [];
    const seen = new Set<string>();
    for (const event of events) {
      const externalKey = ciFailureActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      await handleCiFailureEvent(options, event);
    }
  };
}

function isReviewGateCiFailedEvent(event: WorkflowLifecycleEvent): event is ReviewGateCiFailedLifecycleEvent {
  return event.kind === 'review_gate.ci_failed';
}

export function createCiFailureWorker(options: CiFailureWorkerOptions): WorkerRuntime {
  const pendingEvents: ReviewGateCiFailedLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.ciFailure
      ? createCiFailureTick({
        ...options.ciFailure,
        logger: options.logger,
        drainEvents: () => pendingEvents.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: CI_FAILURE_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_CI_FAILURE_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.ciFailure || options.onTick) {
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isReviewGateCiFailedEvent(event)) return;
          pendingEvents.push(event);
          runtime.wake('wake');
        },
      );
    }
    runtime.start();
  };
  const stop = async (): Promise<void> => {
    lifecycleUnsubscribe?.();
    lifecycleUnsubscribe = undefined;
    await runtime.stop();
  };

  return {
    identity: runtime.identity,
    start,
    wake: runtime.wake,
    tick: runtime.tick,
    stop,
    isRunning: runtime.isRunning,
  };
}

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
  isReviewGateCiContextStale,
  type ReviewGateCiContext,
  type ReviewGateLineageFields,
} from '../auto-fix-intents.js';
import type {
  ReviewGateMergeConflictLifecycleEvent,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND = 'review-gate-merge-conflict';
export const DEFAULT_REVIEW_GATE_MERGE_CONFLICT_WORKER_INTERVAL_MS = 60_000;

const REBASE_RECREATE_CHANNEL = 'invoker:rebase-recreate';
const REVIEW_GATE_MERGE_CONFLICT_ACTION_TYPE = 'rebase-recreate-review-gate-conflict';
const NO_HEAD_SHA = 'no-head';

type ReviewGateMergeConflictActionStatus = WorkerActionStatus;

type HeadlessExecPayload = {
  args?: unknown[];
};

export interface ReviewGateMergeConflictWorkerStore {
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

export interface ReviewGateMergeConflictWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof REBASE_RECREATE_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface ReviewGateMergeConflictWorkerPolicyOptions {
  store: ReviewGateMergeConflictWorkerStore;
  submitter: ReviewGateMergeConflictWorkerSubmitter;
  logger: Logger;
  drainEvents?: () => ReviewGateMergeConflictLifecycleEvent[];
}

export interface ReviewGateMergeConflictWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  reviewGateMergeConflict?: Omit<ReviewGateMergeConflictWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  onTick?: WorkerTick;
}

export function registerReviewGateMergeConflictWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
    note: 'Queues workflow rebase-recreate when a review-gate PR reports merge conflicts.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createReviewGateMergeConflictWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        reviewGateMergeConflict: {
          store: deps.store,
          submitter: deps.submitter,
        },
      }),
  });
  return registry;
}

export function reviewGateMergeConflictActionKey(event: Pick<
  ReviewGateMergeConflictLifecycleEvent,
  'taskId' | 'reviewId' | 'headSha'
>): string {
  return [
    'review-gate-merge-conflict',
    event.taskId,
    event.reviewId,
    event.headSha ?? NO_HEAD_SHA,
  ].join(':');
}

function getHeadlessExecArgs(intent: WorkflowMutationIntent): unknown[] {
  if (intent.channel !== 'headless.exec') {
    return [];
  }
  const payload = intent.args[0] as HeadlessExecPayload | undefined;
  return Array.isArray(payload?.args) ? payload.args : [];
}

function isWorkflowRecreateIntentForWorkflow(intent: WorkflowMutationIntent, workflowId: string): boolean {
  if (intent.channel === REBASE_RECREATE_CHANNEL || intent.channel === 'invoker:recreate-workflow') {
    return typeof intent.args[0] === 'string' && intent.args[0] === workflowId;
  }

  const args = getHeadlessExecArgs(intent);
  return (args[0] === 'rebase-recreate' || args[0] === 'recreate')
    && typeof args[1] === 'string'
    && args[1] === workflowId;
}

function listOpenWorkflowRecreateIntents(
  intents: WorkflowMutationIntent[],
  workflowId: string,
): WorkflowMutationIntent[] {
  return intents.filter((intent) => isWorkflowRecreateIntentForWorkflow(intent, workflowId));
}

function loadTaskForEvent(
  event: ReviewGateMergeConflictLifecycleEvent,
  options: ReviewGateMergeConflictWorkerPolicyOptions,
): TaskState | undefined {
  const direct = options.store.loadTask?.(event.taskId);
  if (direct) return direct;
  return options.store.loadTasks(event.workflowId).find((task) => task.id === event.taskId);
}

function currentReviewGateLineage(task: TaskState, reviewId: string): ReviewGateLineageFields {
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

function reviewGateContextFromEvent(event: ReviewGateMergeConflictLifecycleEvent): ReviewGateCiContext {
  return {
    reviewId: event.reviewId,
    generation: event.generation,
    selectedAttemptId: event.attemptId,
    branch: event.branch,
    headSha: event.headSha,
  };
}

function staleReasonForEvent(
  event: ReviewGateMergeConflictLifecycleEvent,
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

function recordReviewGateMergeConflictAction(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
  status: ReviewGateMergeConflictActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
    actionType: REVIEW_GATE_MERGE_CONFLICT_ACTION_TYPE,
    externalKey: reviewGateMergeConflictActionKey(event),
    subjectType: 'review',
    subjectId: event.reviewId,
    workflowId: event.workflowId,
    taskId: event.taskId,
    status,
    summary,
    intentId,
    incrementAttempt: status === 'queued' || status === 'failed',
    payload: {
      reviewId: event.reviewId,
      reviewUrl: event.reviewUrl,
      headSha: event.headSha ?? null,
      headRef: event.headRef ?? null,
      branch: event.branch ?? null,
      generation: event.generation,
      selectedAttemptId: event.attemptId ?? null,
      taskStateVersion: event.taskStateVersion ?? null,
      ...payload,
    },
  });
}

function logReviewGateMergeConflictEvent(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
  phase: string,
  details: Record<string, unknown>,
): void {
  const payload = {
    phase,
    worker: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
    workflowId: event.workflowId,
    reviewId: event.reviewId,
    headSha: event.headSha ?? null,
    generation: event.generation,
    selectedAttemptId: event.attemptId ?? null,
    ...details,
  };
  options.store.logEvent?.(event.taskId, 'debug.review-gate-merge-conflict-worker', payload);
  options.logger.debug?.(`[worker:${REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND}] ${phase}`, {
    module: 'review-gate-merge-conflict-worker',
    taskId: event.taskId,
    ...payload,
  });
}

function listOpenRecreateIntentsForEvent(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
): WorkflowMutationIntent[] {
  const open = options.store.listWorkflowMutationIntents?.(event.workflowId, ['queued', 'running']) ?? [];
  return listOpenWorkflowRecreateIntents(open, event.workflowId);
}

function shouldSkipExistingAction(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
): WorkerActionRecord | undefined {
  const externalKey = reviewGateMergeConflictActionKey(event);
  const existing = options.store.getWorkerAction?.(REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, externalKey);
  if (!existing) return undefined;
  if (isOpenOrCompletedActionStatus(existing.status)) {
    logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-skip', {
      reason: 'already-recorded',
      existingStatus: existing.status,
      intentId: existing.intentId ?? null,
    });
    return existing;
  }
  return undefined;
}

function firstLine(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.split('\n', 1)[0];
}

function reconcileFinishedIntentAction(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
): void {
  const externalKey = reviewGateMergeConflictActionKey(event);
  const existing = options.store.getWorkerAction?.(REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND, externalKey);
  if (!existing || !existing.intentId) return;
  if (existing.status !== 'queued' && existing.status !== 'pending' && existing.status !== 'running') return;

  const terminalIntents = options.store.listWorkflowMutationIntents?.(event.workflowId, ['completed', 'failed']) ?? [];
  const intent = terminalIntents.find((candidate) => String(candidate.id) === existing.intentId);
  if (!intent) return;

  const now = new Date().toISOString();
  const status: WorkerActionStatus = intent.status === 'completed' ? 'completed' : 'failed';
  const summary = status === 'completed'
    ? 'Workflow rebase-recreate intent completed'
    : `Workflow rebase-recreate intent failed: ${firstLine(intent.error) ?? 'unknown error'}`;
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
  logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-intent-reconciled', {
    intentId: existing.intentId,
    intentStatus: intent.status,
    actionStatus: status,
  });
}

export interface QueueReviewGateMergeConflictRepairResult {
  decision: 'queued' | 'skipped';
  reason: string;
  intentId?: number | string;
}

export async function queueReviewGateMergeConflictRepair(
  options: ReviewGateMergeConflictWorkerPolicyOptions,
  event: ReviewGateMergeConflictLifecycleEvent,
): Promise<QueueReviewGateMergeConflictRepairResult> {
  const task = loadTaskForEvent(event, options);
  if (!task) {
    logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-skip', { reason: 'task-not-found' });
    return { decision: 'skipped', reason: 'task-not-found' };
  }

  reconcileFinishedIntentAction(options, event);

  const existingAction = shouldSkipExistingAction(options, event);
  if (existingAction) {
    return {
      decision: 'skipped',
      reason: 'already-recorded',
      intentId: existingAction.intentId,
    };
  }

  const stale = staleReasonForEvent(event, task);
  if (stale.stale) {
    logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-stale', {
      reason: stale.reason,
      ...stale.details,
    });
    return { decision: 'skipped', reason: stale.reason };
  }

  const openRecreateIntents = listOpenRecreateIntentsForEvent(options, event);
  if (openRecreateIntents.length > 0) {
    const intentId = openRecreateIntents[0]?.id;
    recordReviewGateMergeConflictAction(options, event, 'queued', 'Workflow rebase-recreate already queued for review gate', {
      reason: 'already-queued-intent',
      existingIntentIds: openRecreateIntents.map((intent) => intent.id),
    }, intentId);
    logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-skip', {
      reason: 'already-queued-intent',
      existingIntentIds: openRecreateIntents.map((intent) => intent.id),
    });
    return { decision: 'skipped', reason: 'already-queued-intent', intentId };
  }

  const intentId = options.submitter.submit(event.workflowId, 'high', REBASE_RECREATE_CHANNEL, [event.workflowId]);
  recordReviewGateMergeConflictAction(
    options,
    event,
    'queued',
    'Queued workflow rebase-recreate for review-gate merge conflict',
    { channel: REBASE_RECREATE_CHANNEL },
    intentId,
  );
  logReviewGateMergeConflictEvent(options, event, 'review-gate-merge-conflict-submitted', {
    intentId,
    channel: REBASE_RECREATE_CHANNEL,
  });
  return { decision: 'queued', reason: 'queued', intentId };
}

export function createReviewGateMergeConflictTick(options: ReviewGateMergeConflictWorkerPolicyOptions): WorkerTick {
  return async () => {
    const events = options.drainEvents?.() ?? [];
    const seen = new Set<string>();
    for (const event of events) {
      const externalKey = reviewGateMergeConflictActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      await queueReviewGateMergeConflictRepair(options, event);
    }
  };
}


function isReviewGateMergeConflictEvent(event: WorkflowLifecycleEvent): event is ReviewGateMergeConflictLifecycleEvent {
  return event.kind === 'review_gate.merge_conflict';
}

export function createReviewGateMergeConflictWorker(
  options: ReviewGateMergeConflictWorkerOptions,
): WorkerRuntime {
  const pendingEvents: ReviewGateMergeConflictLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (
    options.reviewGateMergeConflict
      ? createReviewGateMergeConflictTick({
        ...options.reviewGateMergeConflict,
        logger: options.logger,
        drainEvents: () => pendingEvents.splice(0),
      })
      : (() => {})
  );
  const runtime = createWorkerRuntime({
    kind: REVIEW_GATE_MERGE_CONFLICT_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_REVIEW_GATE_MERGE_CONFLICT_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });

  if (!options.messageBus || !options.reviewGateMergeConflict || options.onTick) {
    return runtime;
  }

  const start = (): void => {
    if (!lifecycleUnsubscribe) {
      lifecycleUnsubscribe = options.messageBus?.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isReviewGateMergeConflictEvent(event)) return;
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

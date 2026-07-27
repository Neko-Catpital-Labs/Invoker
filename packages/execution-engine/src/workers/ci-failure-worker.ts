import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkflowMutationIntent,
  WorkflowMutationIntentStatus,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { AutoFixAttemptLedger } from '../auto-fix-attempt-ledger.js';
import {
  classifyFailedChecks,
  createFailedCheckLogFetcher,
  type FailedCheckLogFetcher,
} from '../ci-failure-infra-classifier.js';
import {
  isReviewGateCiContextStale,
  type ReviewGateCiContext,
  type ReviewGateLineageFields,
} from '../auto-fix-intents.js';
import type {
  ReviewGateCiFailedLifecycleEvent,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import {
  ciFailureChecksHash,
  queueRepairWorkflowSpawn,
  repairWorkflowActionKey,
  SPAWN_REPAIR_WORKFLOW_CHANNEL,
  type QueueRepairWorkflowSpawnOptions,
  type RepairWorkflowSpawnStore,
  type RepairWorkflowSpawnSubmitter,
} from '../repair-workflow-spec.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const CI_FAILURE_WORKER_KIND = 'ci-failure';
export const DEFAULT_CI_FAILURE_WORKER_INTERVAL_MS = 60_000;

export interface CiFailureWorkerStore extends RepairWorkflowSpawnStore {
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
}

export type CiFailureWorkerSubmitter = RepairWorkflowSpawnSubmitter;

export interface CiFailureWorkerPolicyOptions extends Omit<QueueRepairWorkflowSpawnOptions, 'logger' | 'store'> {
  store: CiFailureWorkerStore;
  logger: Logger;
  drainEvents?: () => ReviewGateCiFailedLifecycleEvent[];
  /** Deprecated compatibility field; durable retry caps now live in worker_actions. */
  attemptLedger?: AutoFixAttemptLedger;
  /** Optional failed-check log fetcher used to skip non-fixable infra failures. */
  fetchFailedCheckLogs?: FailedCheckLogFetcher;
}

export interface CiFailureWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  ciFailure?: Omit<CiFailureWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  onTick?: WorkerTick;
}

/** Register the built-in CI-failure repair worker. */
export function registerCiFailureWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: CI_FAILURE_WORKER_KIND,
    note: 'Submits head-SHA guarded CI repair workflow spawns for failed review-gate checks.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createCiFailureWorker({
        logger: deps.logger,
        messageBus: deps.messageBus,
        ciFailure: {
          store: deps.store,
          submitter: deps.submitter,
          defaultAutoFixRetries: deps.autoFix?.defaultAutoFixRetries,
          getAutoFixAgent: deps.autoFix?.getAutoFixAgent,
          attemptLedger: deps.autoFix?.attemptLedger,
          getAutoFixExecutionModel: deps.autoFix?.getAutoFixExecutionModel,
          fetchFailedCheckLogs: createFailedCheckLogFetcher({
            cwd: deps.prMaintenance?.repoRoot,
          }),
        },
      }),
  });
  return registry;
}

export function createCiFailureTick(options: CiFailureWorkerPolicyOptions): WorkerTick {
  return async () => {
    const events = options.drainEvents?.() ?? [];
    const seen = new Set<string>();
    for (const event of events) {
      const externalKey = repairWorkflowActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      try {
        await handleCiFailureEvent(options, event);
      } catch (error) {
        options.logger.error(`[worker:${CI_FAILURE_WORKER_KIND}] worker-ci-failure-tick-error`, {
          module: 'ci-failure-worker',
          externalKey,
          taskId: event.taskId,
          workflowId: event.workflowId,
          reviewId: event.reviewId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };
}

function loadTaskForEvent(
  event: ReviewGateCiFailedLifecycleEvent,
  options: CiFailureWorkerPolicyOptions,
): TaskState | undefined {
  const direct = options.store.loadTask?.(event.taskId);
  if (direct) return direct;
  return options.store.loadTasks(event.workflowId).find((task) => task.id === event.taskId);
}

function currentReviewGateArtifact(task: TaskState, reviewId: string) {
  const gate = task.execution.reviewGate;
  return gate?.artifacts.find((candidate) =>
    candidate.generation === gate.activeGeneration
    && candidate.status !== 'discarded'
    && !candidate.discardedAt
    && candidate.providerId === reviewId,
  );
}

function currentReviewGateLineage(
  task: TaskState,
  reviewId: string,
): ReviewGateLineageFields {
  const artifact = currentReviewGateArtifact(task, reviewId);
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

function hasUnresolvedMergeConflictForEvent(
  task: TaskState,
  event: ReviewGateCiFailedLifecycleEvent,
): boolean {
  return currentReviewGateArtifact(task, event.reviewId)?.mergeState === 'dirty';
}

function recordCiFailureDecision(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: CI_FAILURE_WORKER_KIND,
    actionType: 'spawn-repair-workflow',
    externalKey: repairWorkflowActionKey(event),
    subjectType: 'review',
    subjectId: event.reviewId,
    workflowId: event.workflowId,
    taskId: event.taskId,
    status,
    summary,
    intentId,
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
  options: CiFailureWorkerPolicyOptions,
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
    module: 'ci-failure-worker',
    ...payload,
  });
}

function firstLine(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.split('\n', 1)[0];
}

function reconcileFinishedIntentAction(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): void {
  const externalKey = repairWorkflowActionKey(event);
  const existing = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, externalKey);
  if (!existing || !existing.intentId) return;
  if (existing.status !== 'queued' && existing.status !== 'pending' && existing.status !== 'running') return;

  const terminalIntents = options.store.listWorkflowMutationIntents?.(event.workflowId, ['completed', 'failed']) ?? [];
  const intent = terminalIntents.find((candidate) => String(candidate.id) === existing.intentId);
  if (!intent) return;

  const now = new Date().toISOString();
  const status: WorkerActionStatus = intent.status === 'completed' ? 'completed' : 'failed';
  const summary = status === 'completed'
    ? 'CI repair workflow spawn intent completed'
    : `CI repair workflow spawn intent failed: ${firstLine(intent.error) ?? 'unknown error'}`;
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

async function handleCiFailureEvent(
  options: CiFailureWorkerPolicyOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): Promise<void> {
  const task = loadTaskForEvent(event, options);
  if (!task) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: 'task-missing' });
    return;
  }

  reconcileFinishedIntentAction(options, event);

  const stale = staleReasonForEvent(event, task);
  if (stale.stale) {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: stale.reason, ...stale.details });
    return;
  }

  if (hasUnresolvedMergeConflictForEvent(task, event)) {
    recordCiFailureDecision(
      options,
      event,
      'skipped',
      'Skipped CI repair workflow because review gate has an unresolved merge conflict',
      {
        reason: 'merge-conflict-present',
        mergeState: 'dirty',
        conflictOwner: 'review-gate-merge-conflict',
      },
    );
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', {
      reason: 'merge-conflict-present',
      mergeState: 'dirty',
    });
    return;
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
      recordCiFailureDecision(
        options,
        event,
        'skipped',
        'Skipped CI repair workflow because failure looks like runner/infra',
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
      return;
    }
  }

  const result = queueRepairWorkflowSpawn(options, event);
  if (result.decision === 'queued') {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-submitted', {
      intentId: result.intentId,
      channel: SPAWN_REPAIR_WORKFLOW_CHANNEL,
    });
  } else {
    logCiFailureWorkerEvent(options, event, 'worker-ci-failure-skip', { reason: result.reason });
  }
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

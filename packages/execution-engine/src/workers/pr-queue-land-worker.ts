import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationIntent,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';

import type { PrQueueDequeuedLifecycleEvent, WorkflowLifecycleEvent } from '../lifecycle-events.js';
import { releasePrRepairLease, tryAcquirePrRepairLease, type PrRepairLeaseStore } from '../pr-repair-lease.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_QUEUE_LAND_WORKER_KIND = 'pr-queue-land';
export const DEFAULT_PR_QUEUE_LAND_WORKER_INTERVAL_MS = 60_000;
const PR_QUEUE_LAND_ACTION_TYPE = 'land-dequeued-pr';
export const PR_QUEUE_DEQUEUE_REPAIR_CHANNEL = 'invoker:repair-queue-dequeue';
const PR_QUEUE_LAND_COOLDOWN_MS = 30 * 60 * 1000;


export interface PrQueueLandWorkerStore extends PrRepairLeaseStore {
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkflowMutationIntents?(workflowId?: string, statuses?: Array<'completed' | 'failed'>): WorkflowMutationIntent[];
}

export interface PrQueueLandWorkerPolicyOptions {
  store: PrQueueLandWorkerStore;
  submitter?: {
    submit(
      workflowId: string,
      priority: WorkflowMutationPriority,
      channel: typeof PR_QUEUE_DEQUEUE_REPAIR_CHANNEL,
      args: unknown[],
    ): number;
    invalidateIntent(workflowId: string, intentId: string, reason: string): void;
  };
  ensureMappedWorkflow?(event: PrQueueDequeuedLifecycleEvent): Promise<{ workflowId: string } | undefined>;
  logger: Logger;
  drainEvents?: () => PrQueueDequeuedLifecycleEvent[];
}

export interface PrQueueLandWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  prQueueLand?: Omit<PrQueueLandWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  onTick?: WorkerTick;
}

export function prQueueLandActionKey(event: Pick<
  PrQueueDequeuedLifecycleEvent,
  'repo' | 'prNumber' | 'headSha' | 'dequeueCommentId' | 'failedChecks'
>): string {
  return [
    PR_QUEUE_LAND_WORKER_KIND,
    event.repo,
    event.prNumber,
    event.headSha,
    event.dequeueCommentId,
    queueDequeueChecksHash(event.failedChecks),
  ].join(':');
}

export function queueDequeueChecksHash(failedChecks: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify([...failedChecks].map((check) => check.trim()).filter(Boolean).sort()))
    .digest('hex');
}

export function registerPrQueueLandWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_QUEUE_LAND_WORKER_KIND,
    note: 'Submits mapped dequeued PR repair commands.',
    source: 'built-in',
    factory: (deps) => createPrQueueLandWorker({
      logger: deps.logger,
      messageBus: deps.messageBus,
      prQueueLand: {
        store: deps.store,
        submitter: deps.submitter,
        ensureMappedWorkflow: deps.prQueueLand?.ensureMappedWorkflow,
      },
    }),
  });
  return registry;
}
function firstLine(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.split('\n', 1)[0];
}
function repairPreemptionReason(intentId?: number): string {
  return intentId === undefined
    ? 'Superseded by repair preemption'
    : `Superseded by repair preemption intent #${intentId}`;
}

function cooldownUntilIso(updatedAt: string): string | undefined {
  const updatedAtMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedAtMs)) return undefined;
  return new Date(updatedAtMs + PR_QUEUE_LAND_COOLDOWN_MS).toISOString();
}



function reconcileFinishedIntentAction(
  options: PrQueueLandWorkerPolicyOptions,
  event: PrQueueDequeuedLifecycleEvent,
): void {
  const existing = options.store.getWorkerAction?.(PR_QUEUE_LAND_WORKER_KIND, prQueueLandActionKey(event));
  if (!existing?.intentId || !existing.workflowId || !['queued', 'pending', 'running'].includes(existing.status)) return;
  const intents = options.store.listWorkflowMutationIntents?.(existing.workflowId, ['completed', 'failed']) ?? [];
  const intent = intents.find((candidate) => String(candidate.id) === existing.intentId);
  if (!intent) return;
  const payload = existing.payload && typeof existing.payload === 'object'
    ? { ...(existing.payload as Record<string, unknown>) }
    : {};
  const now = new Date().toISOString();
  const status: WorkerActionStatus = intent.status === 'completed' ? 'completed' : 'failed';
  options.store.upsertWorkerAction?.({
    ...existing,
    status,
    summary: status === 'completed'
      ? 'Dequeued PR repair completed'
      : `Dequeued PR repair failed: ${firstLine(intent.error) ?? 'unknown error'}`,
    payload: { ...payload, reconciledIntentStatus: intent.status, intentError: intent.error ?? null },
    updatedAt: now,
    completedAt: now,
  });
  if (typeof payload.prRepairLeaseId === 'string') releasePrRepairLease(payload.prRepairLeaseId, options.store);
}

async function handlePrQueueLandEvent(
  options: PrQueueLandWorkerPolicyOptions,
  event: PrQueueDequeuedLifecycleEvent,
): Promise<void> {
  const externalKey = prQueueLandActionKey(event);
  reconcileFinishedIntentAction(options, event);
  const existing = options.store.getWorkerAction?.(PR_QUEUE_LAND_WORKER_KIND, externalKey);
  if (existing && existing.status !== 'skipped' && existing.status !== 'failed') return;
  if (existing && (existing.status === 'skipped' || existing.status === 'failed')) {
    const cooldownUntil = cooldownUntilIso(existing.updatedAt);
    if (cooldownUntil && cooldownUntil > new Date().toISOString()) {
      recordWorkerDecisionRow(options.store, {
        workerKind: PR_QUEUE_LAND_WORKER_KIND,
        actionType: PR_QUEUE_LAND_ACTION_TYPE,
        externalKey,
        subjectType: 'pull_request',
        subjectId: `${event.repo}#${event.prNumber}`,
        workflowId: event.workflowId ?? existing.workflowId,
        status: 'skipped',
        summary: 'Skipped dequeued PR repair because cooldown is active',
        reason: 'cooldown-active',
        payload: {
          headSha: event.headSha,
          dequeueCommentId: event.dequeueCommentId,
          failedChecks: event.failedChecks,
          failedChecksHash: queueDequeueChecksHash(event.failedChecks),
          stackId: event.stackId,
          stackOrder: event.stackOrder,
          cooldownUntil,
        },
      });
      return;
    }
  }

  const lease = tryAcquirePrRepairLease({
    repo: event.repo,
    prNumber: event.prNumber,
    headSha: event.headSha,
    kind: 'queue_dequeued',
    store: options.store,
    workflowId: event.workflowId,
  });
  if (!lease.ok) {
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId: event.workflowId,
      status: 'skipped',
      summary: 'Skipped dequeued PR landing because a PR repair lease is held',
      reason: 'lease-held',
      payload: {
        headSha: event.headSha,
        holderKind: lease.holderKind,
        failedChecks: event.failedChecks,
        failedChecksHash: queueDequeueChecksHash(event.failedChecks),
      },
    });
    return;
  }
  if (lease.preempted && lease.previousCommandId) {
    options.submitter?.invalidateIntent(event.workflowId ?? '', lease.previousCommandId, repairPreemptionReason());
  }

  let workflowId = event.workflowId;
  if (!workflowId && options.ensureMappedWorkflow) {
    try {
      workflowId = (await options.ensureMappedWorkflow(event))?.workflowId;
      if (workflowId) {
        const activeLease = options.store.getPrRepairLeaseById(lease.leaseId);
        if (activeLease) {
          options.store.upsertPrRepairLease({ ...activeLease, workflowId });
        }
      }
    } catch (error) {
      recordWorkerDecisionRow(options.store, {
        workerKind: PR_QUEUE_LAND_WORKER_KIND,
        actionType: PR_QUEUE_LAND_ACTION_TYPE,
        externalKey,
        subjectType: 'pull_request',
        subjectId: `${event.repo}#${event.prNumber}`,
        status: 'failed',
        summary: 'Failed to bootstrap dequeued PR repair workflow',
        reason: 'workflow-bootstrap-failed',
        payload: {
          headSha: event.headSha,
          dequeueCommentId: event.dequeueCommentId,
          failedChecks: event.failedChecks,
          failedChecksHash: queueDequeueChecksHash(event.failedChecks),
          stackId: event.stackId,
          stackOrder: event.stackOrder,
          error: firstLine(error instanceof Error ? error.message : String(error)),
          prRepairLeaseId: lease.leaseId,
        },
      });
      releasePrRepairLease(lease.leaseId, options.store);
      return;
    }
  }

  if (!workflowId) {
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      status: 'skipped',
      summary: 'Skipped dequeued PR repair because the PR has no mapped workflow',
      reason: 'workflow-unmapped',
      payload: {
        headSha: event.headSha,
        dequeueCommentId: event.dequeueCommentId,
        failedChecks: event.failedChecks,
        failedChecksHash: queueDequeueChecksHash(event.failedChecks),
        stackId: event.stackId,
        stackOrder: event.stackOrder,
        prRepairLeaseId: lease.leaseId,
      },
    });
    releasePrRepairLease(lease.leaseId, options.store);
    return;
  }

  if (!options.submitter) {
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId,
      status: 'skipped',
      summary: 'Skipped dequeued PR repair because the command is not ready',
      reason: 'command-not-ready',
      payload: {
        headSha: event.headSha,
        dequeueCommentId: event.dequeueCommentId,
        failedChecks: event.failedChecks,
        failedChecksHash: queueDequeueChecksHash(event.failedChecks),
        stackId: event.stackId,
        stackOrder: event.stackOrder,
        prRepairLeaseId: lease.leaseId,
      },
    });
    releasePrRepairLease(lease.leaseId, options.store);
    return;
  }

  try {
    const intentId = options.submitter.submit(workflowId, 'high', PR_QUEUE_DEQUEUE_REPAIR_CHANNEL, [{
      repo: event.repo,
      prNumber: event.prNumber,
      headSha: event.headSha,
      leaseId: lease.leaseId,
      holderKind: 'queue_dequeued',
      workflowId,
      eventKey: event.eventKey,
      reason: event.dequeueCommentId,
      failedChecks: event.failedChecks,
    }]);
    const activeLease = options.store.getPrRepairLeaseById(lease.leaseId);
    if (activeLease) {
      options.store.upsertPrRepairLease({ ...activeLease, commandId: String(intentId), workflowId });
    }
    if (lease.preempted && lease.previousCommandId) {
      options.submitter.invalidateIntent(workflowId, lease.previousCommandId, repairPreemptionReason(intentId));
    }
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId,
      status: 'queued',
      summary: 'Queued dequeued PR repair',
      intentId: String(intentId),
      payload: {
        headSha: event.headSha,
        failedChecks: event.failedChecks,
        failedChecksHash: queueDequeueChecksHash(event.failedChecks),
        stackId: event.stackId,
        stackOrder: event.stackOrder,
        prRepairLeaseId: lease.leaseId,
      },
    });
  } catch (error) {
    releasePrRepairLease(lease.leaseId, options.store);
    throw error;
  }
}

export function createPrQueueLandTick(options: PrQueueLandWorkerPolicyOptions): WorkerTick {
  return async () => {
    const seen = new Set<string>();
    for (const event of options.drainEvents?.() ?? []) {
      const externalKey = prQueueLandActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      await handlePrQueueLandEvent(options, event);
    }
  };
}

function isPrQueueDequeuedEvent(event: WorkflowLifecycleEvent): event is PrQueueDequeuedLifecycleEvent {
  return event.kind === 'pr.queue_dequeued';
}

export function createPrQueueLandWorker(options: PrQueueLandWorkerOptions): WorkerRuntime {
  const pendingEvents: PrQueueDequeuedLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (options.prQueueLand
    ? createPrQueueLandTick({ ...options.prQueueLand, logger: options.logger, drainEvents: () => pendingEvents.splice(0) })
    : (() => {}));
  const runtime = createWorkerRuntime({
    kind: PR_QUEUE_LAND_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_QUEUE_LAND_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
  if (!options.messageBus || !options.prQueueLand || options.onTick) return runtime;

  return {
    identity: runtime.identity,
    start: () => {
      lifecycleUnsubscribe ??= options.messageBus!.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isPrQueueDequeuedEvent(event)) return;
          pendingEvents.push(event);
          runtime.wake('wake');
        },
      );
      runtime.start();
    },
    wake: runtime.wake,
    tick: runtime.tick,
    stop: async () => {
      lifecycleUnsubscribe?.();
      lifecycleUnsubscribe = undefined;
      await runtime.stop();
    },
    isRunning: runtime.isRunning,
  };
}

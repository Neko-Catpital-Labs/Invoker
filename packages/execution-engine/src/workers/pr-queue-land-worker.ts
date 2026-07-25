import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
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

export interface PrQueueLandWorkerStore extends PrRepairLeaseStore {
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

export interface PrQueueLandWorkerPolicyOptions {
  store: PrQueueLandWorkerStore;
  submitter: {
    submit(
      workflowId: string,
      priority: WorkflowMutationPriority,
      channel: typeof PR_QUEUE_DEQUEUE_REPAIR_CHANNEL,
      args: unknown[],
    ): number;
  };
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
  'repo' | 'prNumber' | 'headSha' | 'dequeueCommentId'
>): string {
  return [PR_QUEUE_LAND_WORKER_KIND, event.repo, event.prNumber, event.headSha, event.dequeueCommentId].join(':');
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
      prQueueLand: { store: deps.store, submitter: deps.submitter },
    }),
  });
  return registry;
}

function handlePrQueueLandEvent(
  options: PrQueueLandWorkerPolicyOptions,
  event: PrQueueDequeuedLifecycleEvent,
): void {
  const externalKey = prQueueLandActionKey(event);
  if (options.store.getWorkerAction?.(PR_QUEUE_LAND_WORKER_KIND, externalKey)) return;

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
      payload: { headSha: event.headSha, holderKind: lease.holderKind, failedChecks: event.failedChecks },
    });
    return;
  }

  if (!event.workflowId) {
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      status: 'skipped',
      summary: 'Skipped dequeued PR repair because the PR has no mapped workflow',
      reason: 'workflow-unmapped',
      payload: { headSha: event.headSha, prRepairLeaseId: lease.leaseId },
    });
    releasePrRepairLease(lease.leaseId, options.store);
    return;
  }

  try {
    const intentId = options.submitter.submit(event.workflowId, 'high', PR_QUEUE_DEQUEUE_REPAIR_CHANNEL, [{
      repo: event.repo,
      prNumber: event.prNumber,
      headSha: event.headSha,
      leaseId: lease.leaseId,
      holderKind: 'queue_dequeued',
      workflowId: event.workflowId,
      eventKey: event.eventKey,
      reason: event.dequeueCommentId,
    }]);
    recordWorkerDecisionRow(options.store, {
      workerKind: PR_QUEUE_LAND_WORKER_KIND,
      actionType: PR_QUEUE_LAND_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId: event.workflowId,
      status: 'queued',
      summary: 'Queued dequeued PR repair',
      intentId: String(intentId),
      payload: {
        headSha: event.headSha,
        failedChecks: event.failedChecks,
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
      handlePrQueueLandEvent(options, event);
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

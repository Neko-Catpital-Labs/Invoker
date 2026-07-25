import type { Logger } from '@invoker/contracts';
import type {
  PrMirrorRow,
  PrRepairLeaseRow,
  WorkerActionRecord,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';

import type {
  PrQueueDequeuedLifecycleEvent,
  PrReviewCommentLifecycleEvent,
  WorkflowLifecycleEvent,
} from '../lifecycle-events.js';
import { tryAcquirePrRepairLease, type RepairKind } from '../pr-repair-lease.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_REVIEW_COMMENT_WORKER_KIND = 'pr-review-comment';
export const PR_QUEUE_DEQUEUED_WORKER_KIND = 'pr-queue-dequeued';
export const PR_REVIEW_COMMENT_REPAIR_CHANNEL = 'invoker:repair-review-comments';
export const PR_QUEUE_DEQUEUED_REPAIR_CHANNEL = 'invoker:repair-queue-dequeue';
const DEFAULT_INTERVAL_MS = 60_000;

type PrLifecycleSignalEvent = PrReviewCommentLifecycleEvent | PrQueueDequeuedLifecycleEvent;

export interface PrLifecycleSignalWorkerStore {
  getPrMirror?(repo: string, prNumber: number): PrMirrorRow | undefined;
  getPrRepairLease?(repo: string, prNumber: number, headSha: string): PrRepairLeaseRow | undefined;
  upsertPrRepairLease?(lease: PrRepairLeaseRow): PrRepairLeaseRow;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrLifecycleSignalWorkerSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof PR_REVIEW_COMMENT_REPAIR_CHANNEL | typeof PR_QUEUE_DEQUEUED_REPAIR_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface PrLifecycleSignalWorkerPolicyOptions {
  store: PrLifecycleSignalWorkerStore;
  submitter: PrLifecycleSignalWorkerSubmitter;
  logger: Logger;
  drainEvents?: () => PrLifecycleSignalEvent[];
}

export interface PrLifecycleSignalWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  signals?: Omit<PrLifecycleSignalWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  onTick?: WorkerTick;
}

type SignalDefinition = {
  kind: typeof PR_REVIEW_COMMENT_WORKER_KIND | typeof PR_QUEUE_DEQUEUED_WORKER_KIND;
  eventKind: PrLifecycleSignalEvent['kind'];
  leaseKind: RepairKind;
  channel: typeof PR_REVIEW_COMMENT_REPAIR_CHANNEL | typeof PR_QUEUE_DEQUEUED_REPAIR_CHANNEL;
  actionType: string;
  summary: string;
};

const REVIEW_COMMENT: SignalDefinition = {
  kind: PR_REVIEW_COMMENT_WORKER_KIND,
  eventKind: 'pr.review_comment',
  leaseKind: 'review_comments',
  channel: PR_REVIEW_COMMENT_REPAIR_CHANNEL,
  actionType: 'repair-pr-review-comments',
  summary: 'Queued PR review-comment repair intent',
};

const QUEUE_DEQUEUED: SignalDefinition = {
  kind: PR_QUEUE_DEQUEUED_WORKER_KIND,
  eventKind: 'pr.queue_dequeued',
  leaseKind: 'queue_dequeued',
  channel: PR_QUEUE_DEQUEUED_REPAIR_CHANNEL,
  actionType: 'repair-pr-queue-dequeue',
  summary: 'Queued PR queue-dequeue repair intent',
};

export function registerPrLifecycleSignalWorkers(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  for (const definition of [REVIEW_COMMENT, QUEUE_DEQUEUED]) {
    registry.register({
      kind: definition.kind,
      note: `Records ${definition.eventKind} wakeups and submits a deferred PR repair intent.`,
      factory: (deps) => createPrLifecycleSignalWorker(definition, {
        logger: deps.logger,
        messageBus: deps.messageBus,
        signals: { store: deps.store, submitter: deps.submitter },
      }),
    });
  }
  return registry;
}

export function prLifecycleSignalActionKey(event: PrLifecycleSignalEvent): string {
  if (event.kind === 'pr.review_comment') {
    return `${event.kind}:${event.repo}:${event.prNumber}:${event.commentId}`;
  }
  return `${event.kind}:${event.repo}:${event.prNumber}:${event.headSha ?? 'no-head'}:${event.eventKey}`;
}

function record(
  options: PrLifecycleSignalWorkerPolicyOptions,
  definition: SignalDefinition,
  event: PrLifecycleSignalEvent,
  status: 'queued' | 'skipped',
  summary: string,
  payload: Record<string, unknown>,
  intentId?: number,
): void {
  const key = prLifecycleSignalActionKey(event);
  const existing = options.store.getWorkerAction?.(definition.kind, key);
  const now = new Date().toISOString();
  options.store.upsertWorkerAction?.({
    id: existing?.id ?? `${definition.kind}:${key}`,
    workerKind: definition.kind,
    actionType: definition.actionType,
    workflowId: event.workflowId,
    ...(event.taskId ? { taskId: event.taskId } : {}),
    subjectType: 'review',
    subjectId: `${event.repo}#${event.prNumber}`,
    externalKey: key,
    status,
    attemptCount: status === 'queued' ? (existing?.attemptCount ?? 0) + 1 : (existing?.attemptCount ?? 0),
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    summary,
    payload,
    updatedAt: now,
    ...(status === 'skipped' ? { completedAt: now } : {}),
  });
}

function handleSignal(
  options: PrLifecycleSignalWorkerPolicyOptions,
  definition: SignalDefinition,
  event: PrLifecycleSignalEvent,
): void {
  const key = prLifecycleSignalActionKey(event);
  const existing = options.store.getWorkerAction?.(definition.kind, key);
  if (existing?.status === 'queued' || existing?.status === 'completed') return;

  const mirror = options.store.getPrMirror?.(event.repo, event.prNumber);
  const common = { eventKey: event.eventKey, repo: event.repo, prNumber: event.prNumber };
  if (!mirror) {
    record(options, definition, event, 'skipped', 'Skipped PR repair: mirror is missing', { ...common, reason: 'mirror-missing' });
    return;
  }
  if (event.headSha && mirror.headSha !== event.headSha) {
    record(options, definition, event, 'skipped', 'Skipped PR repair: mirror head changed', {
      ...common, reason: 'mirror-head-changed', eventHeadSha: event.headSha, mirrorHeadSha: mirror.headSha,
    });
    return;
  }
  if (!options.store.getPrRepairLease || !options.store.upsertPrRepairLease) {
    record(options, definition, event, 'skipped', 'Skipped PR repair: lease store is unavailable', { ...common, reason: 'lease-store-unavailable' });
    return;
  }
  const lease = tryAcquirePrRepairLease({
    repo: mirror.repo,
    prNumber: mirror.prNumber,
    headSha: mirror.headSha,
    kind: definition.leaseKind,
    workflowId: event.workflowId,
    store: {
      getPrRepairLease: options.store.getPrRepairLease,
      upsertPrRepairLease: options.store.upsertPrRepairLease,
      getPrRepairLeaseById: () => undefined,
      deletePrRepairLeaseById: () => false,
    },
  });
  if (!lease.ok) {
    record(options, definition, event, 'skipped', 'Skipped PR repair: lease is held', {
      ...common, reason: 'pr-repair-lease-denied', holderKind: lease.holderKind,
    });
    return;
  }
  const intentId = options.submitter.submit(event.workflowId, 'normal', definition.channel, [{
    repo: mirror.repo,
    prNumber: mirror.prNumber,
    headSha: mirror.headSha,
    leaseId: lease.leaseId,
    holderKind: definition.leaseKind,
    eventKey: event.eventKey,
  }]);
  record(options, definition, event, 'queued', definition.summary, {
    ...common, channel: definition.channel, prRepairLease: { leaseId: lease.leaseId, holderKind: definition.leaseKind },
  }, intentId);
}

export function createPrLifecycleSignalTick(
  definition: SignalDefinition,
  options: PrLifecycleSignalWorkerPolicyOptions,
): WorkerTick {
  return async () => {
    const seen = new Set<string>();
    for (const event of options.drainEvents?.() ?? []) {
      if (event.kind !== definition.eventKind) continue;
      const key = prLifecycleSignalActionKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      handleSignal(options, definition, event);
    }
  };
}

export function createPrReviewCommentTick(options: PrLifecycleSignalWorkerPolicyOptions): WorkerTick {
  return createPrLifecycleSignalTick(REVIEW_COMMENT, options);
}

export function createPrQueueDequeuedTick(options: PrLifecycleSignalWorkerPolicyOptions): WorkerTick {
  return createPrLifecycleSignalTick(QUEUE_DEQUEUED, options);
}

export function createPrLifecycleSignalWorker(
  definition: SignalDefinition,
  options: PrLifecycleSignalWorkerOptions,
): WorkerRuntime {
  const pending: PrLifecycleSignalEvent[] = [];
  let unsubscribe: Unsubscribe | undefined;
  const runtime = createWorkerRuntime({
    kind: definition.kind,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (options.signals
      ? createPrLifecycleSignalTick(definition, { ...options.signals, logger: options.logger, drainEvents: () => pending.splice(0) })
      : (() => {})),
  });
  if (!options.messageBus || !options.signals || options.onTick) return runtime;
  return {
    ...runtime,
    start: () => {
      unsubscribe ??= options.messageBus!.subscribe<WorkflowLifecycleEvent>(Channels.WORKFLOW_LIFECYCLE, (event) => {
        if (event.kind !== definition.eventKind) return;
        pending.push(event);
        runtime.wake('wake');
      });
      runtime.start();
    },
    stop: async () => {
      unsubscribe?.();
      unsubscribe = undefined;
      await runtime.stop();
    },
  };
}

export function createPrReviewCommentWorker(options: PrLifecycleSignalWorkerOptions): WorkerRuntime {
  return createPrLifecycleSignalWorker(REVIEW_COMMENT, options);
}

export function createPrQueueDequeuedWorker(options: PrLifecycleSignalWorkerOptions): WorkerRuntime {
  return createPrLifecycleSignalWorker(QUEUE_DEQUEUED, options);
}

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, WorkflowMutationPriority } from '@invoker/data-store';
import { Channels, type MessageBus, type Unsubscribe } from '@invoker/transport';

import type { PrReviewCommentsLifecycleEvent, WorkflowLifecycleEvent } from '../lifecycle-events.js';
import { releasePrRepairLease, tryAcquirePrRepairLease, type PrRepairLeaseStore } from '../pr-repair-lease.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const REVIEW_COMMENTS_WORKER_KIND = 'review-comments';
export const DEFAULT_REVIEW_COMMENTS_WORKER_INTERVAL_MS = 60_000;
const REVIEW_COMMENTS_ACTION_TYPE = 'address-review-comments';
export const REVIEW_COMMENTS_REPAIR_CHANNEL = 'invoker:repair-review-comments';

export interface ReviewCommentsWorkerStore extends PrRepairLeaseStore {
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

export interface ReviewCommentsWorkerPolicyOptions {
  store: ReviewCommentsWorkerStore;
  submitter?: {
    submit(
      workflowId: string,
      priority: WorkflowMutationPriority,
      channel: typeof REVIEW_COMMENTS_REPAIR_CHANNEL,
      args: unknown[],
    ): number;
  };
  logger: Logger;
  drainEvents?: () => PrReviewCommentsLifecycleEvent[];
}

export interface ReviewCommentsWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  reviewComments?: Omit<ReviewCommentsWorkerPolicyOptions, 'logger' | 'drainEvents'>;
  tickOnStart?: boolean;
  messageBus?: MessageBus;
  onTick?: WorkerTick;
}

export function reviewCommentsActionKey(event: Pick<
  PrReviewCommentsLifecycleEvent,
  'repo' | 'prNumber' | 'headSha' | 'commentMarker'
>): string {
  return [REVIEW_COMMENTS_WORKER_KIND, event.repo, event.prNumber, event.headSha, event.commentMarker].join(':');
}

export function registerReviewCommentsWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: REVIEW_COMMENTS_WORKER_KIND,
    note: 'Submits mapped review-comment repair commands.',
    source: 'built-in',
    factory: (deps) => createReviewCommentsWorker({
      logger: deps.logger,
      messageBus: deps.messageBus,
      reviewComments: { store: deps.store, submitter: deps.submitter },
    }),
  });
  return registry;
}

function handleReviewCommentsEvent(
  options: ReviewCommentsWorkerPolicyOptions,
  event: PrReviewCommentsLifecycleEvent,
): void {
  const externalKey = reviewCommentsActionKey(event);
  const existing = options.store.getWorkerAction?.(REVIEW_COMMENTS_WORKER_KIND, externalKey);
  if (existing && existing.status !== 'skipped' && existing.status !== 'failed') return;

  const lease = tryAcquirePrRepairLease({
    repo: event.repo,
    prNumber: event.prNumber,
    headSha: event.headSha,
    kind: 'review_comments',
    store: options.store,
    workflowId: event.workflowId,
  });
  if (!lease.ok) {
    recordWorkerDecisionRow(options.store, {
      workerKind: REVIEW_COMMENTS_WORKER_KIND,
      actionType: REVIEW_COMMENTS_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId: event.workflowId,
      status: 'skipped',
      summary: 'Skipped review-comment repair because a PR repair lease is held',
      reason: 'lease-held',
      payload: { headSha: event.headSha, holderKind: lease.holderKind, commentUrls: event.commentUrls },
    });
    return;
  }

  if (!event.workflowId) {
    recordWorkerDecisionRow(options.store, {
      workerKind: REVIEW_COMMENTS_WORKER_KIND,
      actionType: REVIEW_COMMENTS_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      status: 'skipped',
      summary: 'Skipped review-comment repair because the PR has no mapped workflow',
      reason: 'workflow-unmapped',
      payload: { headSha: event.headSha, prRepairLeaseId: lease.leaseId },
    });
    releasePrRepairLease(lease.leaseId, options.store);
    return;
  }

  if (!options.submitter) {
    recordWorkerDecisionRow(options.store, {
      workerKind: REVIEW_COMMENTS_WORKER_KIND,
      actionType: REVIEW_COMMENTS_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId: event.workflowId,
      status: 'skipped',
      summary: 'Skipped review-comment repair because the command is not ready',
      reason: 'command-not-ready',
      payload: { headSha: event.headSha, commentUrls: event.commentUrls, prRepairLeaseId: lease.leaseId },
    });
    releasePrRepairLease(lease.leaseId, options.store);
    return;
  }

  try {
    const intentId = options.submitter.submit(event.workflowId, 'normal', REVIEW_COMMENTS_REPAIR_CHANNEL, [{
      repo: event.repo,
      prNumber: event.prNumber,
      headSha: event.headSha,
      leaseId: lease.leaseId,
      holderKind: 'review_comments',
      workflowId: event.workflowId,
      eventKey: event.eventKey,
      commentUrl: event.commentUrls[0],
    }]);
    recordWorkerDecisionRow(options.store, {
      workerKind: REVIEW_COMMENTS_WORKER_KIND,
      actionType: REVIEW_COMMENTS_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: `${event.repo}#${event.prNumber}`,
      workflowId: event.workflowId,
      status: 'queued',
      summary: 'Queued review-comment repair',
      intentId: String(intentId),
      payload: { headSha: event.headSha, commentUrls: event.commentUrls, prRepairLeaseId: lease.leaseId },
    });
  } catch (error) {
    releasePrRepairLease(lease.leaseId, options.store);
    throw error;
  }
}

export function createReviewCommentsTick(options: ReviewCommentsWorkerPolicyOptions): WorkerTick {
  return async () => {
    const seen = new Set<string>();
    for (const event of options.drainEvents?.() ?? []) {
      const externalKey = reviewCommentsActionKey(event);
      if (seen.has(externalKey)) continue;
      seen.add(externalKey);
      handleReviewCommentsEvent(options, event);
    }
  };
}

function isReviewCommentsEvent(event: WorkflowLifecycleEvent): event is PrReviewCommentsLifecycleEvent {
  return event.kind === 'pr.review_comments';
}

export function createReviewCommentsWorker(options: ReviewCommentsWorkerOptions): WorkerRuntime {
  const pendingEvents: PrReviewCommentsLifecycleEvent[] = [];
  let lifecycleUnsubscribe: Unsubscribe | undefined;
  const onTick = options.onTick ?? (options.reviewComments
    ? createReviewCommentsTick({ ...options.reviewComments, logger: options.logger, drainEvents: () => pendingEvents.splice(0) })
    : (() => {}));
  const runtime = createWorkerRuntime({
    kind: REVIEW_COMMENTS_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_REVIEW_COMMENTS_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
  if (!options.messageBus || !options.reviewComments || options.onTick) return runtime;

  return {
    identity: runtime.identity,
    start: () => {
      lifecycleUnsubscribe ??= options.messageBus!.subscribe<WorkflowLifecycleEvent>(
        Channels.WORKFLOW_LIFECYCLE,
        (event) => {
          if (!isReviewCommentsEvent(event)) return;
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

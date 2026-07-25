import type { SQLiteAdapter } from '@invoker/data-store';
import {
  buildHeadlessFixArgs,
  PR_QUEUE_DEQUEUED_REPAIR_CHANNEL,
  PR_REVIEW_COMMENT_REPAIR_CHANNEL,
  type ReviewGateCiContext,
} from '@invoker/execution-engine';

export { PR_QUEUE_DEQUEUED_REPAIR_CHANNEL, PR_REVIEW_COMMENT_REPAIR_CHANNEL };

type PrLifecycleRepairKind = 'review_comments' | 'queue_dequeued';

export interface PrLifecycleRepairIntent {
  repo: string;
  prNumber: number;
  headSha: string;
  leaseId: string;
  holderKind: PrLifecycleRepairKind;
  workflowId: string;
  eventKey: string;
  commentId?: string;
  commentUrl?: string;
  author?: string;
  queueRule?: string;
  reason?: string;
}

export interface PrLifecycleRepairCommand {
  workflowId: string;
  headlessArgs: string[];
}

export interface PrLifecycleRepairCommandDeps {
  persistence: Pick<
    SQLiteAdapter,
    'findReviewGateByPr' | 'getPrMirror' | 'getPrRepairLease' | 'loadTask' | 'loadWorkflow'
  >;
  now?: () => Date;
}

function requireIntent(
  value: unknown,
  expectedHolderKind: PrLifecycleRepairKind,
): PrLifecycleRepairIntent {
  if (!value || typeof value !== 'object') {
    throw new Error('PR repair intent metadata is required.');
  }
  const intent = value as Partial<PrLifecycleRepairIntent>;
  if (
    typeof intent.repo !== 'string' || intent.repo.length === 0
    || !Number.isInteger(intent.prNumber) || intent.prNumber < 1
    || typeof intent.headSha !== 'string' || intent.headSha.length === 0
    || typeof intent.leaseId !== 'string' || intent.leaseId.length === 0
    || typeof intent.workflowId !== 'string' || intent.workflowId.length === 0
    || typeof intent.eventKey !== 'string' || intent.eventKey.length === 0
    || intent.holderKind !== expectedHolderKind
  ) {
    throw new Error(`Invalid ${expectedHolderKind} PR repair intent metadata.`);
  }
  return intent as PrLifecycleRepairIntent;
}

function validateRepairLease(
  value: unknown,
  expectedHolderKind: PrLifecycleRepairKind,
  deps: PrLifecycleRepairCommandDeps,
): PrLifecycleRepairIntent {
  const intent = requireIntent(value, expectedHolderKind);
  const mirror = deps.persistence.getPrMirror(intent.repo, intent.prNumber);
  if (!mirror || mirror.headSha !== intent.headSha || mirror.workflowId !== intent.workflowId) {
    throw new Error(`PR repair intent is stale for ${intent.repo}#${intent.prNumber}.`);
  }

  const lease = deps.persistence.getPrRepairLease(intent.repo, intent.prNumber, intent.headSha);
  if (
    !lease
    || lease.leaseId !== intent.leaseId
    || lease.holderKind !== expectedHolderKind
    || lease.workflowId !== intent.workflowId
  ) {
    throw new Error(`PR repair lease is no longer held by ${expectedHolderKind}.`);
  }
  if (lease.expiresAt && lease.expiresAt <= (deps.now?.() ?? new Date()).toISOString()) {
    throw new Error(`PR repair lease expired for ${intent.repo}#${intent.prNumber}.`);
  }
  return intent;
}

export function prepareReviewCommentRepair(
  value: unknown,
  deps: PrLifecycleRepairCommandDeps,
): PrLifecycleRepairCommand {
  const intent = validateRepairLease(value, 'review_comments', deps);
  const lookup = deps.persistence.findReviewGateByPr(String(intent.prNumber));
  if (!lookup || lookup.workflowId !== intent.workflowId) {
    throw new Error(`No matching Invoker review-gate workflow for PR ${intent.prNumber}.`);
  }
  const task = deps.persistence.loadTask(lookup.mergeTaskId);
  const reviewId = lookup.reviewId?.trim() || task?.execution.reviewId?.trim();
  if (!task || !reviewId) {
    throw new Error(`PR ${intent.prNumber} is missing its active Invoker merge task.`);
  }

  const context: ReviewGateCiContext = {
    reviewId,
    generation: task.execution.generation ?? lookup.workflowGeneration ?? 0,
    selectedAttemptId: task.execution.selectedAttemptId ?? lookup.selectedAttemptId,
    branch: task.execution.branch ?? lookup.branch,
    headSha: intent.headSha,
    fixContext: [
      `Address review feedback for ${intent.repo}#${intent.prNumber}.`,
      `Lifecycle event: ${intent.eventKey}.`,
      ...(intent.commentUrl ? [`Comment: ${intent.commentUrl}.`] : []),
      ...(intent.author ? [`Author: ${intent.author}.`] : []),
    ].join('\n'),
  };
  return {
    workflowId: intent.workflowId,
    headlessArgs: buildHeadlessFixArgs(task.id, undefined, {
      autoFix: true,
      reviewGateContext: context,
    }),
  };
}

export function prepareQueueDequeueRepair(
  value: unknown,
  deps: PrLifecycleRepairCommandDeps,
): PrLifecycleRepairCommand {
  const intent = validateRepairLease(value, 'queue_dequeued', deps);
  if (!deps.persistence.loadWorkflow(intent.workflowId)) {
    throw new Error(`Invoker workflow ${intent.workflowId} no longer exists.`);
  }
  return {
    workflowId: intent.workflowId,
    headlessArgs: ['rebase-recreate', intent.workflowId],
  };
}

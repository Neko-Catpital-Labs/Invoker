import type { SQLiteAdapter } from '@invoker/data-store';
import {
  GitHubMergeGateProvider,
  queueReviewGateCiRepair,
  type MergeGateApprovalStatus,
  type ReviewGateCiRepairPolicyOptions,
} from '@invoker/execution-engine';

export interface ReviewGateCiRepairCommandResult {
  status: 'queued' | 'skipped' | 'unmapped';
  reason: string;
  message: string;
  prNumber: string;
  workflowId?: string;
  taskId?: string;
}

export interface ReviewGateCiRepairCommandDeps {
  persistence: Pick<SQLiteAdapter, 'findReviewGateByPr' | 'loadTask'>;
  repoRoot: string;
  policy: ReviewGateCiRepairPolicyOptions;
  mergeGateProvider?: Pick<GitHubMergeGateProvider, 'checkApproval'>;
  now?: () => string;
}

export function parseReviewGatePrNumber(prArg: string): string | null {
  const fromUrl = prArg.match(/\/pull\/(\d+)/);
  const bare = fromUrl?.[1] ?? prArg.replace(/^#/, '');
  if (!/^\d+$/.test(bare)) return null;
  return bare;
}

export async function repairReviewGateCiByPr(
  prArg: string,
  deps: ReviewGateCiRepairCommandDeps,
): Promise<ReviewGateCiRepairCommandResult> {
  const prNumber = parseReviewGatePrNumber(prArg);
  if (!prNumber) {
    throw new Error(`Could not parse a PR number from "${prArg}".`);
  }
  const lookup = deps.persistence.findReviewGateByPr(prNumber);
  if (!lookup) {
    return {
      status: 'unmapped',
      reason: 'no-local-workflow',
      message: `No Invoker workflow found for PR ${prNumber}.`,
      prNumber,
    };
  }

  const mergeTask = deps.persistence.loadTask(lookup.mergeTaskId);
  if (!mergeTask) {
    return {
      status: 'skipped',
      reason: 'merge-task-missing',
      message: `PR ${prNumber} maps to workflow ${lookup.workflowId}, but merge task ${lookup.mergeTaskId} is missing.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: lookup.mergeTaskId,
    };
  }

  const provider = deps.mergeGateProvider ?? new GitHubMergeGateProvider();
  const reviewId = lookup.reviewId?.trim() || prNumber;
  const status = await provider.checkApproval({ identifier: reviewId, cwd: deps.repoRoot });
  if (status.lifecycle !== 'open') {
    return {
      status: 'skipped',
      reason: 'review-not-open',
      message: `PR ${prNumber} is ${status.lifecycle}; no CI repair queued.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    };
  }
  if (status.checks?.state !== 'failure' || status.checks.failed.length === 0) {
    return {
      status: 'skipped',
      reason: 'checks-not-failing',
      message: `PR ${prNumber} has no failing checks.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    };
  }

  const createdAt = deps.now?.() ?? new Date().toISOString();
  const generation = mergeTask.execution.generation ?? lookup.workflowGeneration ?? 0;
  const attemptId = mergeTask.execution.selectedAttemptId ?? lookup.selectedAttemptId;
  const result = await queueReviewGateCiRepair(deps.policy, {
    eventKey: `review_gate.ci_failed|workflow:${lookup.workflowId}|task:${mergeTask.id}|scan:${prNumber}`,
    kind: 'review_gate.ci_failed',
    workflowId: lookup.workflowId,
    taskId: mergeTask.id,
    status: mergeTask.status,
    taskStateVersion: mergeTask.taskStateVersion,
    generation,
    attemptId,
    createdAt,
    recoveryWakeup: {
      eventKey: `review_gate.ci_failed|workflow:${lookup.workflowId}|task:${mergeTask.id}|scan:${prNumber}`,
      eventKind: 'review_gate.ci_failed',
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
      taskStateVersion: mergeTask.taskStateVersion,
      generation,
      attemptId,
      createdAt,
      reason: 'review_gate_failure',
      authoritative: false,
    },
    reviewId,
    reviewUrl: status.url,
    headSha: status.headSha,
    headRef: status.headRef,
    branch: mergeTask.execution.branch ?? lookup.branch,
    failedChecks: status.checks.failed,
    statusText: reviewGateStatusText(status),
  });

  return result.decision === 'queued'
    ? {
      status: 'queued',
      reason: result.reason,
      message: `Queued CI repair for PR ${prNumber} on ${mergeTask.id}.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    }
    : {
      status: 'skipped',
      reason: result.reason,
      message: `Skipped PR ${prNumber}: ${result.reason}.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    };
}

function reviewGateStatusText(status: MergeGateApprovalStatus): string {
  if (status.checks?.state === 'failure') return 'CI failed';
  return status.statusText;
}

import type { SQLiteAdapter } from '@invoker/data-store';
import {
  GitHubMergeGateProvider,
  queueReviewGateMergeConflictRepair,
  type ReviewGateMergeConflictWorkerPolicyOptions,
} from '@invoker/execution-engine';

import { parseReviewGatePrNumber } from './review-gate-ci-repair-command.js';

export interface ReviewGateMergeConflictRepairCommandResult {
  status: 'queued' | 'skipped' | 'unmapped';
  reason: string;
  message: string;
  prNumber: string;
  workflowId?: string;
  taskId?: string;
}

export interface ReviewGateMergeConflictRepairCommandDeps {
  persistence: Pick<SQLiteAdapter, 'findReviewGateByPr' | 'loadTask'>;
  repoRoot: string;
  policy: ReviewGateMergeConflictWorkerPolicyOptions;
  mergeGateProvider?: Pick<GitHubMergeGateProvider, 'checkApproval'>;
  now?: () => string;
}

export async function repairReviewGateMergeConflictByPr(
  prArg: string,
  deps: ReviewGateMergeConflictRepairCommandDeps,
): Promise<ReviewGateMergeConflictRepairCommandResult> {
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
      status: 'unmapped',
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
    const reason = `review is ${status.lifecycle} (${status.statusText})`;
    return {
      status: 'skipped',
      reason,
      message: `PR ${prNumber} ${reason}; no merge-conflict repair queued.`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    };
  }
  if (status.hasMergeConflict !== true) {
    const reason = `review status is ${status.statusText}`;
    return {
      status: 'skipped',
      reason,
      message: `PR ${prNumber} has no actionable merge conflict (${status.statusText}).`,
      prNumber,
      workflowId: lookup.workflowId,
      taskId: mergeTask.id,
    };
  }

  const createdAt = deps.now?.() ?? new Date().toISOString();
  const generation = mergeTask.execution.generation ?? lookup.workflowGeneration ?? 0;
  const attemptId = mergeTask.execution.selectedAttemptId ?? lookup.selectedAttemptId;
  const result = await queueReviewGateMergeConflictRepair(deps.policy, {
    eventKey: `review_gate.merge_conflict|workflow:${lookup.workflowId}|task:${mergeTask.id}|scan:${prNumber}`,
    kind: 'review_gate.merge_conflict',
    workflowId: lookup.workflowId,
    taskId: mergeTask.id,
    status: mergeTask.status,
    taskStateVersion: mergeTask.taskStateVersion,
    generation,
    attemptId,
    createdAt,
    reviewId,
    reviewUrl: status.url,
    headSha: status.headSha,
    headRef: status.headRef,
    branch: mergeTask.execution.branch ?? lookup.branch,
    statusText: status.statusText,
  });

  return result.decision === 'queued'
    ? {
      status: 'queued',
      reason: result.reason,
      message: `Queued merge-conflict repair for PR ${prNumber} on ${mergeTask.id}.`,
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

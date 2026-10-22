import { parseForgeProject, type ForgeProvider } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import {
  createDefaultReviewProviders,
  createFailedCheckLogFetcher,
  queueReviewGateCiRepair,
  resolveForgeProvider,
  type MergeGateApprovalStatus,
  type ReviewGateCiRepairPolicyOptions,
  type ReviewProviderRegistry,
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
  mergeGateProvider?: Pick<ForgeProvider, 'checkApproval'>;
  reviewProviderRegistry?: ReviewProviderRegistry;
  repoUrl?: string;
  now?: () => string;
}

export function parseReviewGatePrNumber(prArg: string): string | null {
  const project = parseForgeProject(prArg);
  if (project?.reviewId) return project.reviewId;
  const fromPull = prArg.match(/\/pull\/(\d+)/);
  const fromMr = prArg.match(/\/-\/merge_requests\/(\d+)/);
  const bare = fromPull?.[1] ?? fromMr?.[1] ?? prArg.replace(/^#/, '');
  if (!/^\d+$/.test(bare)) return null;
  return bare;
}

function repoUrlFromReviewArg(prArg: string, explicit?: string): string | undefined {
  if (explicit?.trim()) return explicit.trim();
  const project = parseForgeProject(prArg);
  if (!project) return undefined;
  const scheme = project.kind === 'gitlab' ? 'https' : 'https';
  return `${scheme}://${project.host}/${project.projectPath}`;
}

export async function repairReviewGateCiByPr(
  prArg: string,
  deps: ReviewGateCiRepairCommandDeps,
): Promise<ReviewGateCiRepairCommandResult> {
  const prNumber = parseReviewGatePrNumber(prArg);
  if (!prNumber) {
    throw new Error(`Could not parse a PR/MR number from "${prArg}".`);
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

  const defaults = createDefaultReviewProviders();
  const registry = deps.reviewProviderRegistry ?? defaults.reviewProviderRegistry;
  const repoUrl = repoUrlFromReviewArg(prArg, deps.repoUrl);
  const provider = deps.mergeGateProvider
    ?? (repoUrl
      ? resolveForgeProvider({
        reviewProviderRegistry: registry,
        mergeGateProvider: defaults.mergeGateProvider,
        repoUrl,
      })
      : defaults.mergeGateProvider);
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
  const policy: ReviewGateCiRepairPolicyOptions = {
    ...deps.policy,
    fetchFailedCheckLogs: deps.policy.fetchFailedCheckLogs
      ?? createFailedCheckLogFetcher({
        cwd: deps.repoRoot,
        reviewProviderRegistry: deps.reviewProviderRegistry ?? defaults.reviewProviderRegistry,
      }),
  };
  const result = await queueReviewGateCiRepair(policy, {
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
      message: `Queued CI repair workflow for PR ${prNumber} on ${mergeTask.id}.`,
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

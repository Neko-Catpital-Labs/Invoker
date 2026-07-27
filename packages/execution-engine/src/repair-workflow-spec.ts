import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { PlanDefinition, TaskState } from '@invoker/workflow-core';

import {
  checkAutoFixRetryCap,
  recordAutoFixRetryConsumed,
} from './auto-fix-retry-cap.js';
import type { ReviewGateCiFailedLifecycleEvent } from './lifecycle-events.js';
import { ciFailureChecksHash } from './review-gate-ci-repair.js';
import { shellPosixSingleQuote } from './ssh-git-exec.js';
import {
  recordWorkerDecisionRow,
  type WorkerDecisionStore,
} from './worker-decision-ledger.js';

export const SPAWN_REPAIR_WORKFLOW_CHANNEL = 'invoker:spawn-repair-workflow';
export const REPAIR_WORKFLOW_FIX_TASK_ID = 'repair-ci';
export const REPAIR_WORKFLOW_FAST_FORWARD_TASK_ID = 'fast-forward-pr-branch';

const CI_FAILURE_WORKER_KIND = 'ci-failure';
const REPAIR_WORKFLOW_ACTION_TYPE = 'spawn-repair-workflow';
const NO_HEAD_SHA = 'no-head';

export interface RepairWorkflowUpstreamWorkflow {
  readonly id: string;
  readonly name?: string;
  readonly repoUrl?: string;
  readonly intermediateRepoUrl?: string;
  readonly featureBranch?: string;
}

export interface RepairWorkflowSpawnRequest {
  readonly event: ReviewGateCiFailedLifecycleEvent;
  readonly upstreamWorkflowId: string;
  readonly repoUrl: string;
  readonly intermediateRepoUrl?: string;
  readonly featureBranch: string;
  readonly prHeadSha: string;
  readonly failedCheckNames: readonly string[];
  readonly executionAgent?: string;
  readonly executionModel?: string;
}

export interface BuildRepairWorkflowSpawnRequestOptions {
  readonly upstreamWorkflowId?: string;
  readonly upstreamWorkflow?: RepairWorkflowUpstreamWorkflow;
  readonly repoUrl?: string;
  readonly intermediateRepoUrl?: string;
  readonly featureBranch?: string;
  readonly prHeadSha?: string;
  readonly failedCheckNames?: readonly string[];
  readonly executionAgent?: string;
  readonly executionModel?: string;
}

export interface RepairWorkflowSpawnStore extends WorkerDecisionStore {
  loadTasks?(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  loadWorkflow?(workflowId: string): RepairWorkflowUpstreamWorkflow | undefined;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface RepairWorkflowSpawnSubmitter {
  submit(
    workflowId: string,
    priority: WorkflowMutationPriority,
    channel: typeof SPAWN_REPAIR_WORKFLOW_CHANNEL,
    args: unknown[],
    options?: { deferDrain?: boolean },
  ): number;
}

export interface RepairWorkflowSpawnOptions {
  store: RepairWorkflowSpawnStore;
  submitter: RepairWorkflowSpawnSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getRetryBudget?: (task: TaskState) => number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
}

export interface RepairWorkflowSpawnResult {
  decision: 'queued' | 'skipped';
  reason: string;
  intentId?: number;
  request?: RepairWorkflowSpawnRequest;
}

export function repairWorkflowSpawnActionKey(event: Pick<
  ReviewGateCiFailedLifecycleEvent,
  'taskId' | 'reviewId' | 'headSha' | 'failedChecks'
>): string {
  return [
    'ci-repair-workflow',
    event.taskId,
    event.reviewId,
    event.headSha ?? NO_HEAD_SHA,
    ciFailureChecksHash(event.failedChecks),
  ].join(':');
}

export function buildRepairWorkflowSpawnRequest(
  event: ReviewGateCiFailedLifecycleEvent,
  options: BuildRepairWorkflowSpawnRequestOptions,
): RepairWorkflowSpawnRequest {
  const upstreamWorkflowId = requireNonEmpty(
    options.upstreamWorkflowId ?? options.upstreamWorkflow?.id ?? event.workflowId,
    'upstreamWorkflowId',
  );
  const repoUrl = requireNonEmpty(
    options.repoUrl ?? options.upstreamWorkflow?.repoUrl,
    'repoUrl',
  );
  const featureBranch = requireNonEmpty(
    options.featureBranch ?? options.upstreamWorkflow?.featureBranch ?? event.branch ?? event.headRef,
    'featureBranch',
  );
  const prHeadSha = requireNonEmpty(
    options.prHeadSha ?? event.headSha,
    'prHeadSha',
  );
  const failedCheckNames = normalizeFailedCheckNames(
    options.failedCheckNames ?? event.failedChecks.map((check) => check.name),
  );
  if (failedCheckNames.length === 0) {
    throw new Error('repair workflow spawn requires at least one failed check name');
  }

  const configuredAgent = options.executionAgent?.trim();
  const configuredModel = options.executionModel?.trim();
  return {
    event,
    upstreamWorkflowId,
    repoUrl,
    ...(options.intermediateRepoUrl ?? options.upstreamWorkflow?.intermediateRepoUrl
      ? { intermediateRepoUrl: (options.intermediateRepoUrl ?? options.upstreamWorkflow?.intermediateRepoUrl)! }
      : {}),
    featureBranch,
    prHeadSha,
    failedCheckNames,
    ...(configuredAgent ? { executionAgent: configuredAgent } : {}),
    ...(configuredModel ? { executionModel: configuredModel } : {}),
  };
}

export function buildRepairWorkflowSpec(request: RepairWorkflowSpawnRequest): PlanDefinition {
  const upstreamWorkflowId = requireNonEmpty(request.upstreamWorkflowId, 'upstreamWorkflowId');
  const repoUrl = requireNonEmpty(request.repoUrl, 'repoUrl');
  const featureBranch = requireNonEmpty(request.featureBranch, 'featureBranch');
  const prHeadSha = requireNonEmpty(request.prHeadSha, 'prHeadSha');
  const failedCheckNames = normalizeFailedCheckNames(request.failedCheckNames);
  if (failedCheckNames.length === 0) {
    throw new Error('repair workflow spec requires at least one failed check name');
  }

  const repairBranch = buildRepairWorkflowBranchName(featureBranch, prHeadSha);
  return {
    name: `Repair CI for ${upstreamWorkflowId} ${shortSha(prHeadSha)}`,
    description: `Fix failing review-gate CI for ${featureBranch} at ${prHeadSha}.`,
    onFinish: 'none',
    mergeMode: 'manual',
    repoUrl,
    ...(request.intermediateRepoUrl ? { intermediateRepoUrl: request.intermediateRepoUrl } : {}),
    baseBranch: prHeadSha,
    featureBranch: repairBranch,
    externalDependencies: [{
      workflowId: upstreamWorkflowId,
      taskId: '__merge__',
      requiredStatus: 'completed',
      gatePolicy: 'ci_failed',
    }],
    tasks: [
      {
        id: REPAIR_WORKFLOW_FIX_TASK_ID,
        description: `Fix failing checks on ${repairBranch}`,
        prompt: buildRepairWorkflowFixPrompt(request, repairBranch, failedCheckNames),
        featureBranch: repairBranch,
        ...(request.executionAgent ? { executionAgent: request.executionAgent } : {}),
        ...(request.executionModel ? { executionModel: request.executionModel } : {}),
      },
      {
        id: REPAIR_WORKFLOW_FAST_FORWARD_TASK_ID,
        description: `Fast-forward ${featureBranch} to ${repairBranch}`,
        dependencies: [REPAIR_WORKFLOW_FIX_TASK_ID],
        command: buildRepairWorkflowFastForwardCommand({
          featureBranch,
          repairBranch,
          prHeadSha,
        }),
        featureBranch: repairBranch,
      },
    ],
  };
}

export function parseRepairWorkflowSpawnMutationArgs(args: unknown[]): RepairWorkflowSpawnRequest {
  const request = args[0];
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new Error('spawn-repair-workflow requires a request object');
  }
  const candidate = request as Partial<RepairWorkflowSpawnRequest>;
  if (!candidate.event || candidate.event.kind !== 'review_gate.ci_failed') {
    throw new Error('spawn-repair-workflow request requires a review_gate.ci_failed event');
  }
  return buildRepairWorkflowSpawnRequest(candidate.event, {
    upstreamWorkflowId: candidate.upstreamWorkflowId,
    repoUrl: candidate.repoUrl,
    intermediateRepoUrl: candidate.intermediateRepoUrl,
    featureBranch: candidate.featureBranch,
    prHeadSha: candidate.prHeadSha,
    failedCheckNames: candidate.failedCheckNames,
    executionAgent: candidate.executionAgent,
    executionModel: candidate.executionModel,
  });
}

export function repairWorkflowSpawnWorkflowIdFromArgs(args: unknown[]): string | undefined {
  const request = args[0] as { upstreamWorkflowId?: unknown; event?: { workflowId?: unknown } } | undefined;
  const direct = typeof request?.upstreamWorkflowId === 'string' ? request.upstreamWorkflowId.trim() : '';
  if (direct) return direct;
  const fromEvent = typeof request?.event?.workflowId === 'string' ? request.event.workflowId.trim() : '';
  return fromEvent || undefined;
}

export async function queueRepairWorkflowSpawn(
  options: RepairWorkflowSpawnOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): Promise<RepairWorkflowSpawnResult> {
  const task = loadTaskForEvent(event, options.store);
  if (!task) {
    logRepairWorkflowSpawn(options, event, 'repair-workflow-spawn-skip', { reason: 'task-missing' });
    return { decision: 'skipped', reason: 'task-missing' };
  }

  if (shouldSkipExistingSpawn(options, event)) {
    return { decision: 'skipped', reason: 'already-recorded' };
  }

  const workerRetryBudget = retryBudgetForTask(task, options);
  const retryCap = checkAutoFixRetryCap(options.store, event.taskId, workerRetryBudget);
  if (!retryCap.allowed) {
    recordRepairWorkflowAction(
      options,
      event,
      'skipped',
      'Skipped repair workflow spawn because retry budget is exhausted',
      {
        reason: 'worker-retry-budget-exhausted',
        workerRetryBudget: retryBudgetLabel(retryCap.budget),
      },
    );
    logRepairWorkflowSpawn(options, event, 'repair-workflow-spawn-skip', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    });
    return { decision: 'skipped', reason: 'worker-retry-budget-exhausted' };
  }

  const upstreamWorkflow = options.store.loadWorkflow?.(event.workflowId);
  const configuredAgent = options.getAutoFixAgent?.()?.trim();
  const configuredModel = options.getAutoFixExecutionModel?.()?.trim();
  const request = buildRepairWorkflowSpawnRequest(event, {
    upstreamWorkflow,
    executionAgent: configuredAgent || undefined,
    executionModel: configuredModel || undefined,
  });
  const intentId = options.submitter.submit(
    event.workflowId,
    'normal',
    SPAWN_REPAIR_WORKFLOW_CHANNEL,
    [request],
  );
  recordRepairWorkflowAction(
    options,
    event,
    'queued',
    'Queued CI repair workflow spawn',
    {
      channel: SPAWN_REPAIR_WORKFLOW_CHANNEL,
      repairBranch: buildRepairWorkflowBranchName(request.featureBranch, request.prHeadSha),
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    },
    intentId,
    request.executionAgent,
    request.executionModel,
  );
  recordAutoFixRetryConsumed(options.store, event.taskId, { workflowId: event.workflowId });
  logRepairWorkflowSpawn(options, event, 'repair-workflow-spawn-submitted', {
    intentId,
    channel: SPAWN_REPAIR_WORKFLOW_CHANNEL,
    repairBranch: buildRepairWorkflowBranchName(request.featureBranch, request.prHeadSha),
    workerRetryBudget: retryBudgetLabel(retryCap.budget),
  });
  return { decision: 'queued', reason: 'queued', intentId, request };
}

export function buildRepairWorkflowBranchName(featureBranch: string, prHeadSha: string): string {
  return `repair/${sanitizeBranchPath(featureBranch)}-${shortSha(prHeadSha)}`;
}

export function buildRepairWorkflowFastForwardCommand(input: {
  featureBranch: string;
  repairBranch: string;
  prHeadSha: string;
}): string {
  const featureBranch = normalizeGitBranch(input.featureBranch);
  const repairBranch = normalizeGitBranch(input.repairBranch);
  const prHeadSha = requireNonEmpty(input.prHeadSha, 'prHeadSha');
  const q = shellPosixSingleQuote;
  return `set -euo pipefail
UPSTREAM_BRANCH=${q(featureBranch)}
REPAIR_BRANCH=${q(repairBranch)}
EXPECTED_HEAD_SHA=${q(prHeadSha)}

git fetch --prune origin "+refs/heads/$UPSTREAM_BRANCH:refs/remotes/origin/$UPSTREAM_BRANCH"
CURRENT_HEAD_SHA=$(git rev-parse "refs/remotes/origin/$UPSTREAM_BRANCH^{commit}")

if [ "$CURRENT_HEAD_SHA" != "$EXPECTED_HEAD_SHA" ]; then
  echo "PR branch moved since repair workflow was spawned: expected $EXPECTED_HEAD_SHA, found $CURRENT_HEAD_SHA. Refusing to update." >&2
  exit 21
fi

if ! git merge-base --is-ancestor "$EXPECTED_HEAD_SHA" HEAD; then
  echo "Repair branch head is not a descendant of the captured PR head $EXPECTED_HEAD_SHA. Refusing to update." >&2
  exit 22
fi

git push origin "HEAD:refs/heads/$REPAIR_BRANCH"
git push origin "HEAD:refs/heads/$UPSTREAM_BRANCH"
`;
}

function buildRepairWorkflowFixPrompt(
  request: RepairWorkflowSpawnRequest,
  repairBranch: string,
  failedCheckNames: readonly string[],
): string {
  const checks = failedCheckNames.map((name) => `- ${name}`).join('\n');
  const details = request.event.failedChecks
    .map((check) => {
      const conclusion = check.conclusion ? ` (${check.conclusion})` : '';
      const url = check.detailsUrl ? ` - ${check.detailsUrl}` : '';
      return `- ${check.name}${conclusion}${url}`;
    })
    .join('\n');
  return [
    `Review-gate CI failed for ${request.event.reviewUrl}.`,
    `Upstream workflow: ${request.upstreamWorkflowId}.`,
    `PR branch: ${request.featureBranch}.`,
    `Captured PR head SHA: ${request.prHeadSha}.`,
    `Repair branch: ${repairBranch}.`,
    '',
    'Fix the failing checks and commit the minimal changes needed.',
    '',
    'Failed check names:',
    checks,
    '',
    'Check details from the CI event:',
    details,
  ].join('\n');
}

function loadTaskForEvent(
  event: ReviewGateCiFailedLifecycleEvent,
  store: RepairWorkflowSpawnStore,
): TaskState | undefined {
  const direct = store.loadTask?.(event.taskId);
  if (direct) return direct;
  return (store.loadTasks?.(event.workflowId) ?? []).find((task) => task.id === event.taskId);
}

function retryBudgetForTask(task: TaskState, options: RepairWorkflowSpawnOptions): number {
  return options.getRetryBudget?.(task) ?? options.defaultAutoFixRetries ?? 0;
}

function retryBudgetLabel(budget: number): number | 'unlimited' {
  return budget === Number.POSITIVE_INFINITY ? 'unlimited' : budget;
}

function shouldSkipExistingSpawn(
  options: RepairWorkflowSpawnOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): boolean {
  const externalKey = repairWorkflowSpawnActionKey(event);
  const existing = options.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, externalKey);
  if (!existing) return false;
  if (isOpenOrCompletedActionStatus(existing.status)) {
    logRepairWorkflowSpawn(options, event, 'repair-workflow-spawn-skip', {
      reason: 'already-recorded',
      existingStatus: existing.status,
      intentId: existing.intentId ?? null,
    });
    return true;
  }
  return false;
}

function isOpenOrCompletedActionStatus(status: string): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'completed';
}

function recordRepairWorkflowAction(
  options: RepairWorkflowSpawnOptions,
  event: ReviewGateCiFailedLifecycleEvent,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
  agentName?: string,
  executionModel?: string,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: CI_FAILURE_WORKER_KIND,
    actionType: REPAIR_WORKFLOW_ACTION_TYPE,
    externalKey: repairWorkflowSpawnActionKey(event),
    subjectType: 'review',
    subjectId: event.reviewId,
    workflowId: event.workflowId,
    taskId: event.taskId,
    status,
    summary,
    incrementAttempt: status === 'queued',
    ...(intentId !== undefined ? { intentId: String(intentId) } : {}),
    ...(agentName ? { agentName } : {}),
    ...(executionModel ? { executionModel } : {}),
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
      failedCheckNames: event.failedChecks.map((check) => check.name),
      ...payload,
    },
  });
}

function logRepairWorkflowSpawn(
  options: RepairWorkflowSpawnOptions,
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
  options.store.logEvent?.(event.taskId, 'debug.repair-workflow-spawn', payload);
  options.logger.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] ${phase}`, {
    module: 'repair-workflow-spec',
    ...payload,
  });
}

function normalizeFailedCheckNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const name of names ?? []) {
    const trimmed = name.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

function requireNonEmpty(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`repair workflow spawn requires ${label}`);
  return trimmed;
}

function shortSha(sha: string): string {
  return requireNonEmpty(sha, 'prHeadSha').slice(0, 8);
}

function sanitizeBranchPath(branch: string): string {
  return normalizeGitBranch(branch)
    .replace(/[^A-Za-z0-9._/-]+/g, '-')
    .replace(/\/+/g, '/')
    .replace(/\.\.+/g, '.')
    .replace(/(^[./]+|[./]+$)/g, '')
    .replace(/\.lock$/i, '-lock')
    || 'unknown-branch';
}

function normalizeGitBranch(branch: string): string {
  return requireNonEmpty(branch, 'featureBranch')
    .replace(/^refs\/heads\//, '')
    .replace(/^origin\//, '');
}

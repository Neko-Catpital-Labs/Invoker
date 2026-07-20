import type { Logger } from '@invoker/contracts';
import type { Workflow, WorkflowMutationIntent, WorkflowMutationIntentStatus } from '@invoker/data-store';
import {
  createAutoFixAttemptLedger,
  listReviewGateCiRepairRecoveryEvents,
  queueReviewGateCiRepair,
  type AutoFixAttemptLedger,
  type ReviewGateCiRepairResult,
  type ReviewGateCiRepairStore,
  type ReviewGateCiRepairSubmitter,
  type ReviewGateCiFailedLifecycleEvent,
} from '@invoker/execution-engine';
import type { TaskState } from '@invoker/workflow-core';

export type ReviewGateCiRepairCommandDecision = 'queued' | 'skipped' | 'unmapped';

export interface ReviewGateCiRepairTarget {
  input: string;
  prNumber?: string;
  normalizedUrl?: string;
  reviewId?: string;
}

export interface ReviewGateCiRepairCommandResult {
  ok: true;
  decision: ReviewGateCiRepairCommandDecision;
  reason: string;
  target: ReviewGateCiRepairTarget;
  workflowId?: string;
  taskId?: string;
  reviewId?: string;
  reviewUrl?: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  statusText?: string;
  failedChecks?: Array<{ name: string; conclusion?: string; detailsUrl?: string }>;
  intentId?: number;
}

export interface ReviewGateCiRepairQueryResult {
  ok: true;
  decision: 'queued' | 'skipped' | 'unmapped';
  reason: string;
  target: ReviewGateCiRepairTarget;
  workflowId?: string;
  taskId?: string;
  reviewId?: string;
  reviewUrl?: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  statusText?: string;
  checksState?: string;
  mergeState?: string;
  failedChecks?: Array<{ name: string; conclusion?: string; detailsUrl?: string }>;
}

export interface ReviewGateCiRepairCommandStore extends ReviewGateCiRepairStore {
  listWorkflows(): ReadonlyArray<Pick<Workflow, 'id'>>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkflowMutationIntents?(
    workflowId?: string,
    statuses?: WorkflowMutationIntentStatus[],
  ): WorkflowMutationIntent[];
}

export interface ReviewGateCiRepairCommandOptions {
  store: ReviewGateCiRepairCommandStore;
  submitter: ReviewGateCiRepairSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  getRetryBudget?: (task: TaskState) => number;
  attemptLedger?: AutoFixAttemptLedger;
  now?: () => string;
  queueRepair?: typeof queueReviewGateCiRepair;
}

export interface ReviewGateCiRepairQueryOptions {
  store: ReviewGateCiRepairCommandStore;
  logger: Logger;
  now?: () => string;
}

interface ReviewGateArtifact {
  id?: string;
  providerId?: string;
  provider?: string;
  required?: boolean;
  status?: string;
  generation?: number;
  url?: string;
  headSha?: string;
  headRef?: string;
  branch?: string;
  checksState?: string;
  failedChecks?: ReadonlyArray<{ name: string; conclusion?: string; detailsUrl?: string }>;
  mergeState?: string;
  rawStatus?: string;
  discardedAt?: string;
}

interface ReviewGateState {
  activeGeneration?: number;
  artifacts?: readonly ReviewGateArtifact[];
}

type ReviewGateTaskState = TaskState & {
  execution: TaskState['execution'] & {
    reviewGate?: ReviewGateState;
    reviewId?: string;
    reviewUrl?: string;
  };
};

interface ReviewGateMatch {
  workflowId: string;
  task: TaskState;
  artifact?: ReviewGateArtifact;
  reviewId?: string;
  reviewUrl?: string;
}

interface ResolvedRepairTarget {
  target: ReviewGateCiRepairTarget;
  event?: ReviewGateCiFailedLifecycleEvent;
  match?: ReviewGateMatch;
}

function canonicalizeUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const withoutHash = trimmed.split('#', 1)[0] ?? trimmed;
  const withoutQuery = withoutHash.split('?', 1)[0] ?? withoutHash;
  return withoutQuery.replace(/\/+$/, '');
}

function githubPullNumberFromUrl(value: string | undefined): string | undefined {
  const canonical = canonicalizeUrl(value);
  if (!canonical) return undefined;
  const match = canonical.match(/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)$/i);
  return match?.[1];
}

function pullNumberFromReviewId(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (/^\d+$/.test(trimmed)) return trimmed;
  const hashMatch = trimmed.match(/#(\d+)$/);
  if (hashMatch) return hashMatch[1];
  const prIdMatch = trimmed.match(/^pr-(\d+)$/i);
  return prIdMatch?.[1];
}

export function normalizeReviewGateCiRepairTarget(targetArg: unknown): ReviewGateCiRepairTarget {
  const input = String(targetArg ?? '').trim();
  const normalizedUrl = canonicalizeUrl(input);
  const urlPrNumber = githubPullNumberFromUrl(input);
  const reviewIdPrNumber = pullNumberFromReviewId(input);
  const shouldKeepNormalizedUrl = Boolean(
    normalizedUrl && (normalizedUrl !== input || normalizedUrl.startsWith('http')),
  );
  return {
    input,
    ...(urlPrNumber ?? reviewIdPrNumber ? { prNumber: urlPrNumber ?? reviewIdPrNumber } : {}),
    ...(shouldKeepNormalizedUrl ? { normalizedUrl } : {}),
    ...(input && !input.startsWith('http') ? { reviewId: input } : {}),
  };
}

function reviewGateForTask(task: TaskState): ReviewGateState | undefined {
  return (task as ReviewGateTaskState).execution.reviewGate;
}

function executionReviewId(task: TaskState): string | undefined {
  return (task as ReviewGateTaskState).execution.reviewId;
}

function executionReviewUrl(task: TaskState): string | undefined {
  return (task as ReviewGateTaskState).execution.reviewUrl;
}

function artifactReviewId(task: TaskState, artifact: ReviewGateArtifact | undefined): string | undefined {
  return artifact?.providerId ?? executionReviewId(task);
}

function artifactReviewUrl(task: TaskState, artifact: ReviewGateArtifact | undefined): string | undefined {
  return artifact?.url ?? executionReviewUrl(task);
}

function artifactPullNumber(task: TaskState, artifact: ReviewGateArtifact | undefined): string | undefined {
  return pullNumberFromReviewId(artifact?.providerId)
    ?? githubPullNumberFromUrl(artifactReviewUrl(task, artifact))
    ?? pullNumberFromReviewId(executionReviewId(task))
    ?? pullNumberFromReviewId(artifact?.id);
}

function reviewTargetMatches(
  target: ReviewGateCiRepairTarget,
  task: TaskState,
  artifact?: ReviewGateArtifact,
): boolean {
  const reviewId = artifactReviewId(task, artifact);
  const reviewUrl = artifactReviewUrl(task, artifact);
  const reviewNumber = artifactPullNumber(task, artifact);
  const canonicalTargetUrl = target.normalizedUrl;
  const canonicalReviewUrl = canonicalizeUrl(reviewUrl);
  return Boolean(
    (target.input && reviewId === target.input)
      || (target.input && artifact?.id === target.input)
      || (target.input && canonicalReviewUrl === canonicalizeUrl(target.input))
      || (canonicalTargetUrl && canonicalReviewUrl === canonicalTargetUrl)
      || (target.prNumber && reviewNumber === target.prNumber),
  );
}

function listReviewGateMatches(
  store: ReviewGateCiRepairCommandStore,
  target: ReviewGateCiRepairTarget,
): ReviewGateMatch[] {
  const matches: ReviewGateMatch[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (!task.config.isMergeNode) continue;
      const gate = reviewGateForTask(task);
      const artifacts = gate?.artifacts;
      if (artifacts && artifacts.length > 0) {
        for (const artifact of artifacts) {
          if (!reviewTargetMatches(target, task, artifact)) continue;
          matches.push({
            workflowId: workflow.id,
            task,
            artifact,
            reviewId: artifactReviewId(task, artifact),
            reviewUrl: artifactReviewUrl(task, artifact),
          });
        }
        continue;
      }
      if (reviewTargetMatches(target, task)) {
        matches.push({
          workflowId: workflow.id,
          task,
          reviewId: executionReviewId(task),
          reviewUrl: executionReviewUrl(task),
        });
      }
    }
  }
  return matches;
}

function eventMatchesTarget(
  target: ReviewGateCiRepairTarget,
  event: ReviewGateCiFailedLifecycleEvent,
): boolean {
  const eventNumber = githubPullNumberFromUrl(event.reviewUrl) ?? pullNumberFromReviewId(event.reviewId);
  return Boolean(
    event.reviewId === target.input
      || canonicalizeUrl(event.reviewUrl) === canonicalizeUrl(target.input)
      || (target.normalizedUrl && canonicalizeUrl(event.reviewUrl) === target.normalizedUrl)
      || (target.prNumber && eventNumber === target.prNumber),
  );
}

function eventMatchesReviewGateMatch(
  event: ReviewGateCiFailedLifecycleEvent,
  match: ReviewGateMatch,
): boolean {
  return event.workflowId === match.workflowId
    && event.taskId === match.task.id
    && (!match.reviewId || event.reviewId === match.reviewId);
}

function resolveRepairTarget(
  options: ReviewGateCiRepairQueryOptions,
  targetArg: unknown,
): ResolvedRepairTarget {
  const target = normalizeReviewGateCiRepairTarget(targetArg);
  const matches = listReviewGateMatches(options.store, target);
  const events = listReviewGateCiRepairRecoveryEvents({
    store: options.store,
    logger: options.logger,
    now: options.now,
  }).filter((event) => eventMatchesTarget(target, event));

  const event = events.find((candidate) => matches.some((match) => eventMatchesReviewGateMatch(candidate, match)))
    ?? events[0];
  const match = event
    ? matches.find((candidate) => eventMatchesReviewGateMatch(event, candidate))
    : matches[0];
  return { target, event, match };
}

function skippedReasonForMatch(match: ReviewGateMatch | undefined): string {
  if (!match) return 'no-workflow-mapped-review-gate';
  const artifact = match.artifact;
  const gate = reviewGateForTask(match.task);
  if (match.task.status !== 'review_ready' && match.task.status !== 'awaiting_approval') {
    return 'review-gate-not-waiting';
  }
  if (!artifact) return 'no-current-ci-failure';
  if (artifact.mergeState === 'dirty') return 'review-gate-merge-conflict';
  if (artifact.required !== true) return 'review-gate-not-required';
  if (artifact.generation !== gate?.activeGeneration) return 'review-gate-generation-stale';
  if (artifact.status !== 'open' || artifact.discardedAt) return 'review-gate-not-open';
  if (artifact.checksState !== 'failure') return 'no-current-ci-failure';
  if (!artifact.failedChecks || artifact.failedChecks.length === 0) return 'no-failed-checks';
  return 'no-current-ci-failure';
}

function resultFieldsFromEvent(
  event: ReviewGateCiFailedLifecycleEvent,
): Pick<
  ReviewGateCiRepairCommandResult,
  'workflowId' | 'taskId' | 'reviewId' | 'reviewUrl' | 'headSha' | 'headRef' | 'branch' | 'statusText' | 'failedChecks'
> {
  return {
    workflowId: event.workflowId,
    taskId: event.taskId,
    reviewId: event.reviewId,
    reviewUrl: event.reviewUrl,
    ...(event.headSha ? { headSha: event.headSha } : {}),
    ...(event.headRef ? { headRef: event.headRef } : {}),
    ...(event.branch ? { branch: event.branch } : {}),
    statusText: event.statusText,
    failedChecks: event.failedChecks.map((check) => ({ ...check })),
  };
}

function queryFieldsFromMatch(
  match: ReviewGateMatch,
): Pick<
  ReviewGateCiRepairQueryResult,
  'workflowId' | 'taskId' | 'reviewId' | 'reviewUrl' | 'headSha' | 'headRef' | 'branch' | 'checksState' | 'mergeState' | 'statusText' | 'failedChecks'
> {
  const artifact = match.artifact;
  return {
    workflowId: match.workflowId,
    taskId: match.task.id,
    ...(match.reviewId ? { reviewId: match.reviewId } : {}),
    ...(match.reviewUrl ? { reviewUrl: match.reviewUrl } : {}),
    ...(artifact?.headSha ? { headSha: artifact.headSha } : {}),
    ...(artifact?.headRef ? { headRef: artifact.headRef } : {}),
    ...(artifact?.branch ?? match.task.execution.branch ? { branch: artifact?.branch ?? match.task.execution.branch } : {}),
    ...(artifact?.checksState ? { checksState: artifact.checksState } : {}),
    ...(artifact?.mergeState ? { mergeState: artifact.mergeState } : {}),
    ...(artifact?.rawStatus ? { statusText: artifact.rawStatus } : {}),
    ...(artifact?.failedChecks ? { failedChecks: artifact.failedChecks.map((check) => ({ ...check })) } : {}),
  };
}

export function queryReviewGateCiRepairTarget(
  options: ReviewGateCiRepairQueryOptions,
  targetArg: unknown,
): ReviewGateCiRepairQueryResult {
  const resolved = resolveRepairTarget(options, targetArg);
  if (!resolved.match && !resolved.event) {
    return {
      ok: true,
      decision: 'unmapped',
      reason: 'no-workflow-mapped-review-gate',
      target: resolved.target,
    };
  }
  if (!resolved.event) {
    return {
      ok: true,
      decision: 'skipped',
      reason: skippedReasonForMatch(resolved.match),
      target: resolved.target,
      ...(resolved.match ? queryFieldsFromMatch(resolved.match) : {}),
    };
  }
  return {
    ok: true,
    decision: 'queued',
    reason: 'current-ci-failure',
    target: resolved.target,
    ...resultFieldsFromEvent(resolved.event),
  };
}

export async function runReviewGateCiRepairCommand(
  options: ReviewGateCiRepairCommandOptions,
  targetArg: unknown,
): Promise<ReviewGateCiRepairCommandResult> {
  const resolved = resolveRepairTarget(options, targetArg);
  if (!resolved.match && !resolved.event) {
    return {
      ok: true,
      decision: 'unmapped',
      reason: 'no-workflow-mapped-review-gate',
      target: resolved.target,
    };
  }
  if (!resolved.event) {
    return {
      ok: true,
      decision: 'skipped',
      reason: skippedReasonForMatch(resolved.match),
      target: resolved.target,
      ...(resolved.match ? queryFieldsFromMatch(resolved.match) : {}),
    };
  }

  const repair: ReviewGateCiRepairResult = await (options.queueRepair ?? queueReviewGateCiRepair)({
    store: options.store,
    submitter: options.submitter,
    logger: options.logger,
    defaultAutoFixRetries: options.defaultAutoFixRetries,
    getAutoFixAgent: options.getAutoFixAgent,
    getAutoFixExecutionModel: options.getAutoFixExecutionModel,
    getRetryBudget: options.getRetryBudget,
    attemptLedger: options.attemptLedger ?? createAutoFixAttemptLedger(),
  }, resolved.event);

  return {
    ok: true,
    decision: repair.decision,
    reason: repair.reason,
    target: resolved.target,
    ...resultFieldsFromEvent(resolved.event),
    ...(repair.intentId !== undefined ? { intentId: repair.intentId } : {}),
  };
}

export function resolveReviewGateWorkflowIdForPrTarget(
  store: ReviewGateCiRepairCommandStore,
  targetArg: unknown,
): string | undefined {
  const target = normalizeReviewGateCiRepairTarget(targetArg);
  return listReviewGateMatches(store, target)[0]?.workflowId;
}

export function formatReviewGateCiRepairResult(
  result: ReviewGateCiRepairCommandResult | ReviewGateCiRepairQueryResult,
): string {
  const lines = [
    `review-gate-ci-repair: ${result.decision}`,
    `reason: ${result.reason}`,
  ];
  if (result.workflowId) lines.push(`workflow: ${result.workflowId}`);
  if (result.taskId) lines.push(`task: ${result.taskId}`);
  if (result.reviewUrl) lines.push(`review: ${result.reviewUrl}`);
  else if (result.reviewId) lines.push(`review: ${result.reviewId}`);
  if (result.headSha) lines.push(`head: ${result.headSha}`);
  if ('intentId' in result && result.intentId !== undefined) lines.push(`intent: ${result.intentId}`);
  return lines.join('\n');
}

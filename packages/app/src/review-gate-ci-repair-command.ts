import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import {
  ciFailureActionKey,
  createAutoFixAttemptLedger,
  listReviewGateCiRepairRecoveryEvents,
  queueReviewGateCiRepair,
  type AutoFixAttemptLedger,
  type ReviewGateCiFailedLifecycleEvent,
  type ReviewGateCiRepairResult,
  type ReviewGateCiRepairStore,
  type ReviewGateCiRepairSubmitter,
  type ReviewGateFailedCheck,
  type WorkerActionRecord,
} from '@invoker/execution-engine';

const CI_FAILURE_WORKER_KIND = 'ci-failure';

type ReviewGateArtifact = {
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
  failedChecks?: readonly ReviewGateFailedCheck[];
  mergeState?: string;
  rawStatus?: string;
  discardedAt?: string;
};

type ReviewGateState = {
  activeGeneration?: number;
  artifacts?: readonly ReviewGateArtifact[];
};

type ReviewGateTaskState = TaskState & {
  execution: TaskState['execution'] & {
    reviewGate?: ReviewGateState;
    reviewId?: string;
  };
};

export type ReviewGateCiRepairDecision = 'queued' | 'skipped' | 'unmapped';

export interface ParsedReviewGateCiRepairTarget {
  raw: string;
  prNumber?: string;
  owner?: string;
  repo?: string;
}

export interface ReviewGateCiRepairMapping {
  workflowId: string;
  taskId: string;
  reviewId: string;
  reviewUrl: string;
  status: TaskState['status'];
  generation: number;
  selectedAttemptId?: string;
  taskStateVersion?: number;
  headSha?: string;
  headRef?: string;
  branch?: string;
  checksState?: string;
  mergeState?: string;
  failedChecks: ReviewGateFailedCheck[];
  statusText: string;
  repairable: boolean;
  skipReason?: string;
  event?: ReviewGateCiFailedLifecycleEvent;
}

export interface ReviewGateCiRepairInspection {
  decision: ReviewGateCiRepairDecision;
  reason: string;
  target: string;
  mapping?: ReviewGateCiRepairMapping;
  mappedCount: number;
  action?: WorkerActionRecord;
  intentId?: number | string;
}

export interface ReviewGateCiRepairCommandResult extends ReviewGateCiRepairInspection {
  queueResult?: ReviewGateCiRepairResult;
}

export interface ReviewGateCiRepairCommandDeps {
  store: ReviewGateCiRepairStore;
  submitter?: ReviewGateCiRepairSubmitter;
  logger: Logger;
  defaultAutoFixRetries?: number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
  attemptLedger?: AutoFixAttemptLedger;
  now?: () => string;
}

export interface ReviewGateCiRepairCommandArgs {
  target: string;
  output: 'text' | 'json';
}

function reviewGateForTask(task: TaskState): ReviewGateState | undefined {
  return (task as ReviewGateTaskState).execution.reviewGate;
}

function executionReviewId(task: TaskState): string | undefined {
  return (task as ReviewGateTaskState).execution.reviewId;
}

function normalizeFailedChecks(failedChecks: readonly ReviewGateFailedCheck[] | undefined): ReviewGateFailedCheck[] {
  return (failedChecks ?? []).map((check) => ({
    name: check.name,
    conclusion: check.conclusion,
    detailsUrl: check.detailsUrl,
  }));
}

function parsePrLikeValue(value: string | undefined): ParsedReviewGateCiRepairTarget | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;

  try {
    const url = new URL(raw);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (match) {
      return {
        raw,
        owner: match[1]?.toLowerCase(),
        repo: match[2]?.toLowerCase(),
        prNumber: match[3],
      };
    }
  } catch {
    // Not a URL; continue with identifier forms below.
  }

  const ownerRepoHash = raw.match(/^([^/\s#]+)\/([^/\s#]+)#(\d+)$/);
  if (ownerRepoHash) {
    return {
      raw,
      owner: ownerRepoHash[1]?.toLowerCase(),
      repo: ownerRepoHash[2]?.toLowerCase(),
      prNumber: ownerRepoHash[3],
    };
  }

  const ownerRepoPull = raw.match(/^([^/\s#]+)\/([^/\s#]+)\/pull\/(\d+)$/);
  if (ownerRepoPull) {
    return {
      raw,
      owner: ownerRepoPull[1]?.toLowerCase(),
      repo: ownerRepoPull[2]?.toLowerCase(),
      prNumber: ownerRepoPull[3],
    };
  }

  const hash = raw.match(/^#(\d+)$/);
  if (hash) {
    return { raw, prNumber: hash[1] };
  }

  const numeric = raw.match(/^(\d+)$/);
  if (numeric) {
    return { raw, prNumber: numeric[1] };
  }

  const trailingPull = raw.match(/\/pull\/(\d+)(?:\/|$)/);
  if (trailingPull) {
    return { raw, prNumber: trailingPull[1] };
  }

  return { raw };
}

export function parseReviewGateCiRepairTarget(rawTarget: unknown): ParsedReviewGateCiRepairTarget {
  const target = String(rawTarget ?? '').trim();
  if (!target) {
    throw new Error('Usage: --headless repair-review-gate-ci <prNumber|prUrl>');
  }
  return parsePrLikeValue(target) ?? { raw: target };
}

function normalizedIdentity(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

function candidateIdentityValues(mapping: {
  reviewId?: string;
  reviewUrl?: string;
  artifact?: ReviewGateArtifact;
}): string[] {
  return [
    mapping.reviewId,
    mapping.reviewUrl,
    mapping.artifact?.id,
    mapping.artifact?.providerId,
    mapping.artifact?.url,
  ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
}

function targetMatchesIdentity(
  target: ParsedReviewGateCiRepairTarget,
  identityValues: string[],
): boolean {
  const targetRaw = normalizedIdentity(target.raw);
  if (!targetRaw) return false;

  for (const value of identityValues) {
    const normalizedValue = normalizedIdentity(value);
    if (normalizedValue === targetRaw) return true;
  }

  if (!target.prNumber) return false;

  for (const value of identityValues) {
    const parsed = parsePrLikeValue(value);
    if (!parsed?.prNumber || parsed.prNumber !== target.prNumber) continue;
    if (target.owner && parsed.owner && target.owner !== parsed.owner) continue;
    if (target.repo && parsed.repo && target.repo !== parsed.repo) continue;
    return true;
  }

  return false;
}

function repairabilityForArtifact(
  task: TaskState,
  gate: ReviewGateState,
  artifact: ReviewGateArtifact,
  reviewId: string,
): { repairable: true } | { repairable: false; skipReason: string } {
  if (!task.config.workflowId) {
    return { repairable: false, skipReason: 'workflow-missing' };
  }
  if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') {
    return { repairable: false, skipReason: 'status-changed' };
  }
  if (artifact.required !== true) {
    return { repairable: false, skipReason: 'review-gate-not-required' };
  }
  if (artifact.generation !== gate.activeGeneration) {
    return { repairable: false, skipReason: 'generation-changed' };
  }
  if (artifact.status !== 'open' || artifact.discardedAt) {
    return { repairable: false, skipReason: 'review-gate-closed' };
  }
  if (!reviewId) {
    return { repairable: false, skipReason: 'review-missing' };
  }
  if (artifact.mergeState === 'dirty') {
    return { repairable: false, skipReason: 'merge-conflict' };
  }
  if (artifact.checksState !== 'failure') {
    return { repairable: false, skipReason: 'ci-not-failing' };
  }
  if (normalizeFailedChecks(artifact.failedChecks).length === 0) {
    return { repairable: false, skipReason: 'no-failed-checks' };
  }
  return { repairable: true };
}

function eventKeyForMapping(mapping: Pick<ReviewGateCiRepairMapping, 'workflowId' | 'taskId' | 'reviewId' | 'headSha' | 'failedChecks'>): string {
  return ciFailureActionKey({
    taskId: mapping.taskId,
    reviewId: mapping.reviewId,
    headSha: mapping.headSha,
    failedChecks: mapping.failedChecks,
  });
}

function selectRepairableEvent(
  mapping: ReviewGateCiRepairMapping,
  events: readonly ReviewGateCiFailedLifecycleEvent[],
): ReviewGateCiFailedLifecycleEvent | undefined {
  const expectedKey = eventKeyForMapping(mapping);
  return events.find((event) => ciFailureActionKey(event) === expectedKey);
}

function buildArtifactMapping(
  task: TaskState,
  artifact: ReviewGateArtifact,
  events: readonly ReviewGateCiFailedLifecycleEvent[],
): ReviewGateCiRepairMapping | undefined {
  const gate = reviewGateForTask(task);
  const workflowId = task.config.workflowId;
  const fallbackReviewId = executionReviewId(task);
  const reviewId = artifact.providerId ?? fallbackReviewId ?? artifact.id;
  if (!gate || !workflowId || !reviewId) return undefined;

  const failedChecks = normalizeFailedChecks(artifact.failedChecks);
  const repairability = repairabilityForArtifact(task, gate, artifact, reviewId);
  const mapping: ReviewGateCiRepairMapping = {
    workflowId,
    taskId: task.id,
    reviewId,
    reviewUrl: artifact.url ?? reviewId,
    status: task.status,
    generation: task.execution.generation ?? 0,
    selectedAttemptId: task.execution.selectedAttemptId,
    taskStateVersion: task.taskStateVersion,
    headSha: artifact.headSha,
    headRef: artifact.headRef,
    branch: task.execution.branch ?? artifact.branch,
    checksState: artifact.checksState,
    mergeState: artifact.mergeState,
    failedChecks,
    statusText: artifact.rawStatus ?? 'CI failed',
    repairable: repairability.repairable,
    ...(repairability.repairable ? {} : { skipReason: repairability.skipReason }),
  };
  if (mapping.repairable) {
    const event = selectRepairableEvent(mapping, events);
    if (event) {
      mapping.event = event;
    } else {
      mapping.repairable = false;
      mapping.skipReason = 'ci-repair-event-unavailable';
    }
  }
  return mapping;
}

function buildReviewIdOnlyMapping(task: TaskState): ReviewGateCiRepairMapping | undefined {
  const workflowId = task.config.workflowId;
  const reviewId = executionReviewId(task);
  if (!workflowId || !reviewId) return undefined;
  return {
    workflowId,
    taskId: task.id,
    reviewId,
    reviewUrl: reviewId,
    status: task.status,
    generation: task.execution.generation ?? 0,
    selectedAttemptId: task.execution.selectedAttemptId,
    taskStateVersion: task.taskStateVersion,
    branch: task.execution.branch,
    failedChecks: [],
    statusText: 'No persisted review-gate CI failure artifact',
    repairable: false,
    skipReason: 'review-gate-artifact-missing',
  };
}

function dedupeMappings(mappings: ReviewGateCiRepairMapping[]): ReviewGateCiRepairMapping[] {
  const seen = new Set<string>();
  const deduped: ReviewGateCiRepairMapping[] = [];
  for (const mapping of mappings) {
    const key = [
      mapping.workflowId,
      mapping.taskId,
      mapping.reviewId,
      mapping.headSha ?? '',
      mapping.checksState ?? '',
      mapping.mergeState ?? '',
    ].join('\0');
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(mapping);
  }
  return deduped;
}

export function listReviewGateCiRepairMappings(
  rawTarget: unknown,
  deps: Pick<ReviewGateCiRepairCommandDeps, 'store' | 'logger' | 'now'>,
): ReviewGateCiRepairMapping[] {
  const target = parseReviewGateCiRepairTarget(rawTarget);
  const listWorkflows = deps.store.listWorkflows;
  if (!listWorkflows) {
    deps.logger.debug('[review-gate-ci-repair-command] mapping skipped: listWorkflows unavailable', {
      module: 'review-gate-ci-repair-command',
    });
    return [];
  }

  const events = listReviewGateCiRepairRecoveryEvents({
    store: deps.store,
    logger: deps.logger,
    now: deps.now,
  });
  const mappings: ReviewGateCiRepairMapping[] = [];
  let workflows: ReadonlyArray<{ id: string }>;
  try {
    workflows = listWorkflows.call(deps.store);
  } catch (error) {
    deps.logger.error('[review-gate-ci-repair-command] failed to list workflows', {
      module: 'review-gate-ci-repair-command',
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  for (const workflow of workflows) {
    let tasks: TaskState[];
    try {
      tasks = deps.store.loadTasks(workflow.id);
    } catch (error) {
      deps.logger.error('[review-gate-ci-repair-command] failed to load workflow tasks', {
        module: 'review-gate-ci-repair-command',
        workflowId: workflow.id,
        error: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    for (const task of tasks) {
      const gate = reviewGateForTask(task);
      const taskReviewId = executionReviewId(task);
      if (!task.config.isMergeNode && !gate && !taskReviewId) continue;

      for (const artifact of gate?.artifacts ?? []) {
        const reviewId = artifact.providerId ?? taskReviewId ?? artifact.id;
        const reviewUrl = artifact.url ?? reviewId;
        if (!targetMatchesIdentity(target, candidateIdentityValues({ reviewId, reviewUrl, artifact }))) {
          continue;
        }
        const mapping = buildArtifactMapping(task, artifact, events);
        if (mapping) mappings.push(mapping);
      }

      if (!gate?.artifacts?.length && taskReviewId) {
        if (!targetMatchesIdentity(target, candidateIdentityValues({ reviewId: taskReviewId, reviewUrl: taskReviewId }))) {
          continue;
        }
        const mapping = buildReviewIdOnlyMapping(task);
        if (mapping) mappings.push(mapping);
      }
    }
  }

  return dedupeMappings(mappings).sort((a, b) => {
    if (a.repairable !== b.repairable) return a.repairable ? -1 : 1;
    return a.workflowId.localeCompare(b.workflowId) || a.taskId.localeCompare(b.taskId);
  });
}

function openOrQueuedAction(action: WorkerActionRecord | undefined): boolean {
  return action?.status === 'queued'
    || action?.status === 'pending'
    || action?.status === 'running'
    || action?.status === 'needs_input'
    || action?.status === 'review_ready';
}

function actionReason(action: WorkerActionRecord | undefined): string | undefined {
  if (!action) return undefined;
  const payload = action.payload;
  if (payload && typeof payload === 'object' && 'reason' in payload) {
    const reason = (payload as { reason?: unknown }).reason;
    if (typeof reason === 'string' && reason.length > 0) return reason;
  }
  if (action.status === 'queued' || action.status === 'pending' || action.status === 'running') {
    return 'already-recorded';
  }
  return action.status;
}

function inspectSelectedMapping(
  target: ParsedReviewGateCiRepairTarget,
  mappings: ReviewGateCiRepairMapping[],
  deps: Pick<ReviewGateCiRepairCommandDeps, 'store'>,
): ReviewGateCiRepairInspection {
  if (mappings.length === 0) {
    return {
      decision: 'unmapped',
      reason: 'no-workflow-review-gate',
      target: target.raw,
      mappedCount: 0,
    };
  }

  const repairable = mappings.filter((mapping) => mapping.repairable && mapping.event);
  if (repairable.length > 1) {
    return {
      decision: 'skipped',
      reason: 'ambiguous-review-gate-mapping',
      target: target.raw,
      mapping: repairable[0],
      mappedCount: mappings.length,
    };
  }

  const selected = repairable[0] ?? mappings[0];
  const action = selected.event
    ? deps.store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, ciFailureActionKey(selected.event))
    : undefined;
  if (openOrQueuedAction(action)) {
    return {
      decision: 'queued',
      reason: actionReason(action) ?? 'already-recorded',
      target: target.raw,
      mapping: selected,
      mappedCount: mappings.length,
      action,
      intentId: action?.intentId,
    };
  }
  if (!selected.repairable || !selected.event) {
    return {
      decision: 'skipped',
      reason: selected.skipReason ?? 'ci-repair-unavailable',
      target: target.raw,
      mapping: selected,
      mappedCount: mappings.length,
      action,
      intentId: action?.intentId,
    };
  }
  if (action?.status === 'completed') {
    return {
      decision: 'skipped',
      reason: 'already-recorded',
      target: target.raw,
      mapping: selected,
      mappedCount: mappings.length,
      action,
      intentId: action.intentId,
    };
  }
  if (action?.status === 'skipped') {
    return {
      decision: 'skipped',
      reason: actionReason(action) ?? action.status,
      target: target.raw,
      mapping: selected,
      mappedCount: mappings.length,
      action,
      intentId: action.intentId,
    };
  }
  return {
    decision: 'skipped',
    reason: 'not-queued',
    target: target.raw,
    mapping: selected,
    mappedCount: mappings.length,
    action,
    intentId: action?.intentId,
  };
}

export function inspectReviewGateCiRepairTarget(
  rawTarget: unknown,
  deps: Pick<ReviewGateCiRepairCommandDeps, 'store' | 'logger' | 'now'>,
): ReviewGateCiRepairInspection {
  const target = parseReviewGateCiRepairTarget(rawTarget);
  const mappings = listReviewGateCiRepairMappings(target.raw, deps);
  return inspectSelectedMapping(target, mappings, deps);
}

export function resolveReviewGateCiRepairWorkflowId(
  rawTarget: unknown,
  deps: Pick<ReviewGateCiRepairCommandDeps, 'store' | 'logger' | 'now'>,
): string | undefined {
  const mappings = listReviewGateCiRepairMappings(rawTarget, deps);
  if (mappings.length === 0) return undefined;
  const repairable = mappings.filter((mapping) => mapping.repairable && mapping.event);
  if (repairable.length === 1) return repairable[0]?.workflowId;
  if (repairable.length > 1) return undefined;
  return mappings[0]?.workflowId;
}

export function parseReviewGateCiRepairCommandArgs(args: string[]): ReviewGateCiRepairCommandArgs {
  let target: string | undefined;
  let output: ReviewGateCiRepairCommandArgs['output'] = 'text';
  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--output' && i + 1 < args.length) {
      const value = args[i + 1];
      if (value !== 'text' && value !== 'json') {
        throw new Error(`Invalid --output format: "${value}". Must be text|json.`);
      }
      output = value;
      i += 2;
      continue;
    }
    if (arg?.startsWith('--')) {
      throw new Error(`Unknown repair-review-gate-ci flag: "${arg}"`);
    }
    if (target) {
      throw new Error('Usage: --headless repair-review-gate-ci <prNumber|prUrl>');
    }
    target = arg;
    i += 1;
  }
  return {
    target: parseReviewGateCiRepairTarget(target).raw,
    output,
  };
}

export async function repairReviewGateCiForTarget(
  rawTarget: unknown,
  deps: ReviewGateCiRepairCommandDeps,
): Promise<ReviewGateCiRepairCommandResult> {
  const target = parseReviewGateCiRepairTarget(rawTarget);
  const mappings = listReviewGateCiRepairMappings(target.raw, deps);
  const inspection = inspectSelectedMapping(target, mappings, deps);
  if (inspection.decision === 'unmapped') {
    return inspection;
  }
  if (inspection.reason === 'ambiguous-review-gate-mapping') {
    return inspection;
  }
  const mapping = inspection.mapping;
  if (!mapping?.repairable || !mapping.event) {
    return inspection;
  }

  if (!deps.submitter) {
    throw new Error('review-gate CI repair submitter is unavailable');
  }

  const result = await queueReviewGateCiRepair({
    store: deps.store,
    submitter: deps.submitter,
    logger: deps.logger,
    defaultAutoFixRetries: deps.defaultAutoFixRetries,
    getAutoFixAgent: deps.getAutoFixAgent,
    getAutoFixExecutionModel: deps.getAutoFixExecutionModel,
    attemptLedger: deps.attemptLedger ?? createAutoFixAttemptLedger(),
  }, mapping.event);

  return {
    ...inspection,
    decision: result.decision,
    reason: result.reason,
    intentId: result.intentId,
    queueResult: result,
  };
}

function compactMapping(mapping: ReviewGateCiRepairMapping | undefined): Record<string, unknown> | undefined {
  if (!mapping) return undefined;
  return {
    workflowId: mapping.workflowId,
    taskId: mapping.taskId,
    reviewId: mapping.reviewId,
    reviewUrl: mapping.reviewUrl,
    status: mapping.status,
    generation: mapping.generation,
    selectedAttemptId: mapping.selectedAttemptId ?? null,
    taskStateVersion: mapping.taskStateVersion ?? null,
    headSha: mapping.headSha ?? null,
    headRef: mapping.headRef ?? null,
    branch: mapping.branch ?? null,
    checksState: mapping.checksState ?? null,
    mergeState: mapping.mergeState ?? null,
    failedChecks: mapping.failedChecks,
    failedCheckCount: mapping.failedChecks.length,
    statusText: mapping.statusText,
    repairable: mapping.repairable,
    skipReason: mapping.skipReason ?? null,
  };
}

export function serializeReviewGateCiRepairResult(
  result: ReviewGateCiRepairInspection | ReviewGateCiRepairCommandResult,
): Record<string, unknown> {
  return {
    decision: result.decision,
    reason: result.reason,
    target: result.target,
    mappedCount: result.mappedCount,
    intentId: result.intentId ?? null,
    mapping: compactMapping(result.mapping),
    action: result.action
      ? {
        id: result.action.id,
        status: result.action.status,
        intentId: result.action.intentId ?? null,
        summary: result.action.summary,
        updatedAt: result.action.updatedAt,
      }
      : null,
  };
}

export function formatReviewGateCiRepairResult(
  result: ReviewGateCiRepairInspection | ReviewGateCiRepairCommandResult,
  output: 'text' | 'json' = 'text',
): string {
  if (output === 'json') {
    return `${JSON.stringify(serializeReviewGateCiRepairResult(result))}\n`;
  }
  if (result.decision === 'unmapped') {
    return `unmapped review-gate CI repair target "${result.target}" reason=${result.reason}\n`;
  }
  const mapping = result.mapping;
  const details = [
    `workflow=${mapping?.workflowId ?? 'unknown'}`,
    `task=${mapping?.taskId ?? 'unknown'}`,
    `review=${mapping?.reviewId ?? 'unknown'}`,
    `reason=${result.reason}`,
    result.intentId !== undefined ? `intent=${result.intentId}` : undefined,
  ].filter((part): part is string => typeof part === 'string');
  return `${result.decision} review-gate CI repair for "${result.target}" ${details.join(' ')}\n`;
}

export async function runReviewGateCiRepairCommand(
  args: string[],
  deps: ReviewGateCiRepairCommandDeps,
): Promise<ReviewGateCiRepairCommandResult> {
  const parsed = parseReviewGateCiRepairCommandArgs(args);
  const result = await repairReviewGateCiForTarget(parsed.target, deps);
  process.stdout.write(formatReviewGateCiRepairResult(result, parsed.output));
  return result;
}

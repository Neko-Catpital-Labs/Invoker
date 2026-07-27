import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkflowMutationPriority,
} from '@invoker/data-store';
import type { PlanDefinition, TaskState } from '@invoker/workflow-core';

import { normalizeAutoFixRetryBudget } from './auto-fix-gating.js';
import { checkAutoFixRetryCap, recordAutoFixRetryConsumed } from './auto-fix-retry-cap.js';
import type {
  ReviewGateCiFailedLifecycleEvent,
  ReviewGateFailedCheck,
} from './lifecycle-events.js';
import { ciFailureChecksHash } from './review-gate-ci-repair.js';
import { recordWorkerDecisionRow } from './worker-decision-ledger.js';

export const SPAWN_REPAIR_WORKFLOW_CHANNEL = 'invoker:spawn-repair-workflow';

const CI_FAILURE_WORKER_KIND = 'ci-failure';
const REPAIR_WORKFLOW_ACTION_TYPE = 'spawn-repair-workflow';
const NO_HEAD_SHA = 'no-head';

export interface SpawnRepairWorkflowCommandPayload {
  readonly event: ReviewGateCiFailedLifecycleEvent;
  readonly upstreamWorkflowId: string;
  readonly upstreamFeatureBranch: string;
  readonly prHeadSha: string;
  readonly failedCheckNames: readonly string[];
  readonly source?: 'worker' | 'human';
  readonly queuedByRepairWorkflowGuard?: boolean;
}

export interface RepairWorkflowSpecInput {
  readonly event: ReviewGateCiFailedLifecycleEvent;
  readonly upstreamWorkflowId?: string;
  readonly upstreamFeatureBranch?: string;
  readonly prHeadSha?: string;
  readonly failedCheckNames?: readonly string[];
  readonly repoUrl?: string;
  readonly intermediateRepoUrl?: string;
  readonly executionAgent?: string;
  readonly executionModel?: string;
}

export interface RepairWorkflowSpawnStore {
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  loadWorkflow?(workflowId: string): {
    id: string;
    name?: string;
    repoUrl?: string;
    intermediateRepoUrl?: string;
    featureBranch?: string;
    baseBranch?: string;
  } | undefined;
  listWorkflows?(): Array<{
    id: string;
    name?: string;
    repoUrl?: string;
    intermediateRepoUrl?: string;
    featureBranch?: string;
    baseBranch?: string;
  }>;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface RepairWorkflowSpawnOrchestrator {
  getWorkflowIds(): string[];
  loadPlan(plan: PlanDefinition, opts?: { allowGraphMutation?: boolean }): void;
  startExecution(): TaskState[];
  getAllTasks(): TaskState[];
}

export interface RepairWorkflowSpawnOptions {
  store: RepairWorkflowSpawnStore;
  orchestrator: RepairWorkflowSpawnOrchestrator;
  logger?: Logger;
  allowGraphMutation?: boolean;
  defaultAutoFixRetries?: number;
  getRetryBudget?: (task: TaskState) => number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
}

export interface RepairWorkflowSpawnResult {
  decision: 'spawned' | 'skipped';
  reason: string;
  workflowId?: string;
  started: TaskState[];
  tasks: TaskState[];
  spec?: PlanDefinition;
  actionKey: string;
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

export interface QueueRepairWorkflowSpawnOptions {
  store: RepairWorkflowSpawnStore;
  submitter: RepairWorkflowSpawnSubmitter;
  logger?: Logger;
  defaultAutoFixRetries?: number;
  getRetryBudget?: (task: TaskState) => number;
  getAutoFixAgent?: () => string | undefined;
  getAutoFixExecutionModel?: () => string | undefined;
}

export interface QueueRepairWorkflowSpawnResult {
  decision: 'queued' | 'skipped';
  reason: string;
  intentId?: number;
}

export function failedCheckNamesFromCiFailureEvent(
  event: Pick<ReviewGateCiFailedLifecycleEvent, 'failedChecks'>,
): string[] {
  return event.failedChecks.map((check) => check.name);
}

export function repairWorkflowActionKey(event: Pick<
  ReviewGateCiFailedLifecycleEvent,
  'taskId' | 'reviewId' | 'headSha' | 'failedChecks'
>): string {
  return [
    'ci-failure',
    event.taskId,
    event.reviewId,
    event.headSha ?? NO_HEAD_SHA,
    ciFailureChecksHash(event.failedChecks),
  ].join(':');
}

export function buildSpawnRepairWorkflowCommandPayload(
  event: ReviewGateCiFailedLifecycleEvent,
  overrides: {
    upstreamWorkflowId?: string;
    upstreamFeatureBranch?: string;
    prHeadSha?: string;
    failedCheckNames?: readonly string[];
    source?: 'worker' | 'human';
    queuedByRepairWorkflowGuard?: boolean;
  } = {},
): SpawnRepairWorkflowCommandPayload {
  const upstreamWorkflowId = requiredString(
    overrides.upstreamWorkflowId ?? event.workflowId,
    'upstreamWorkflowId',
  );
  const upstreamFeatureBranch = requiredString(
    overrides.upstreamFeatureBranch ?? event.branch ?? event.headRef,
    'upstreamFeatureBranch',
  );
  const prHeadSha = requiredString(
    overrides.prHeadSha ?? event.headSha,
    'prHeadSha',
  );
  const failedCheckNames = overrides.failedCheckNames?.length
    ? [...overrides.failedCheckNames]
    : failedCheckNamesFromCiFailureEvent(event);
  if (failedCheckNames.length === 0) {
    throw new Error('failedCheckNames must contain at least one failed check name');
  }
  return {
    event,
    upstreamWorkflowId,
    upstreamFeatureBranch,
    prHeadSha,
    failedCheckNames,
    ...(overrides.source ? { source: overrides.source } : {}),
    ...(overrides.queuedByRepairWorkflowGuard ? { queuedByRepairWorkflowGuard: true } : {}),
  };
}

export function parseSpawnRepairWorkflowMutationArgs(args: readonly unknown[]): SpawnRepairWorkflowCommandPayload {
  const raw = args[0];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('spawn-repair-workflow expects a command payload object');
  }
  const payload = raw as Partial<SpawnRepairWorkflowCommandPayload>;
  const event = payload.event;
  if (!event || typeof event !== 'object' || event.kind !== 'review_gate.ci_failed') {
    throw new Error('spawn-repair-workflow payload.event must be a review_gate.ci_failed event');
  }
  return buildSpawnRepairWorkflowCommandPayload(event, {
    upstreamWorkflowId: payload.upstreamWorkflowId,
    upstreamFeatureBranch: payload.upstreamFeatureBranch,
    prHeadSha: payload.prHeadSha,
    failedCheckNames: payload.failedCheckNames,
    source: payload.source ?? 'human',
    queuedByRepairWorkflowGuard: payload.queuedByRepairWorkflowGuard,
  });
}

export function buildRepairWorkflowSpec(input: RepairWorkflowSpecInput): PlanDefinition {
  const payload = buildSpawnRepairWorkflowCommandPayload(input.event, {
    upstreamWorkflowId: input.upstreamWorkflowId,
    upstreamFeatureBranch: input.upstreamFeatureBranch,
    prHeadSha: input.prHeadSha,
    failedCheckNames: input.failedCheckNames,
  });
  const repoUrl = requiredString(input.repoUrl, 'repoUrl');
  const repairBranch = repairBranchName(payload.upstreamFeatureBranch, payload.prHeadSha);
  const failedCheckNames = payload.failedCheckNames.map((name) => `- ${name}`).join('\n');
  const failedCheckDetails = formatFailedChecks(input.event.failedChecks);
  const prompt = [
    `Review-gate CI failed for ${input.event.reviewUrl}.`,
    `Upstream workflow: ${payload.upstreamWorkflowId}.`,
    `PR branch: ${payload.upstreamFeatureBranch}.`,
    `Captured PR head SHA: ${payload.prHeadSha}.`,
    `Repair branch to publish: ${repairBranch}.`,
    '',
    'Failed checks:',
    failedCheckDetails || failedCheckNames,
    '',
    'Fix the failing checks on this repair branch. Run focused verification for the failed checks when practical.',
    'Do not push, force-push, merge, rebase, open a PR, or update the PR branch yourself; the final workflow step publishes only by fast-forward if the PR branch still points at the captured head SHA.',
  ].join('\n');

  return {
    name: `Repair CI for ${payload.upstreamFeatureBranch} ${shortSha(payload.prHeadSha)}`,
    description: `Repair failed CI checks for ${payload.upstreamFeatureBranch} at ${payload.prHeadSha}.`,
    onFinish: 'none',
    mergeMode: 'automatic',
    baseBranch: payload.prHeadSha,
    featureBranch: repairBranch,
    repoUrl,
    ...(input.intermediateRepoUrl ? { intermediateRepoUrl: input.intermediateRepoUrl } : {}),
    externalDependencies: [{
      workflowId: payload.upstreamWorkflowId,
      taskId: '__merge__',
      gatePolicy: 'ci_failed',
    }],
    tasks: [
      {
        id: 'repair-ci',
        description: `Fix failed CI checks for ${payload.upstreamFeatureBranch}`,
        prompt,
        ...(input.executionAgent ? { executionAgent: input.executionAgent } : {}),
        ...(input.executionModel ? { executionModel: input.executionModel } : {}),
      },
      {
        id: 'publish-repair',
        description: `Fast-forward ${payload.upstreamFeatureBranch} to repair head`,
        dependencies: ['repair-ci'],
        command: buildFastForwardRepairCommand({
          upstreamFeatureBranch: payload.upstreamFeatureBranch,
          prHeadSha: payload.prHeadSha,
          repairBranch,
        }),
      },
    ],
  };
}

export function repairBranchName(upstreamFeatureBranch: string, prHeadSha: string): string {
  return `repair/${sanitizeBranchPath(upstreamFeatureBranch)}-${shortSha(prHeadSha)}`;
}

export function buildFastForwardRepairCommand(input: {
  upstreamFeatureBranch: string;
  prHeadSha: string;
  repairBranch: string;
}): string {
  const featureBranch = shellSingleQuote(stripRefsHeadsPrefix(input.upstreamFeatureBranch));
  const expectedHead = shellSingleQuote(input.prHeadSha);
  const repairBranch = shellSingleQuote(input.repairBranch);
  return [
    'set -euo pipefail',
    'remote="${INVOKER_REPAIR_REMOTE:-origin}"',
    `feature_branch=${featureBranch}`,
    `expected_head=${expectedHead}`,
    `repair_branch=${repairBranch}`,
    'git fetch "$remote" "+refs/heads/${feature_branch}:refs/remotes/${remote}/${feature_branch}"',
    'current_head="$(git rev-parse "refs/remotes/${remote}/${feature_branch}^{commit}")"',
    'if [ "$current_head" != "$expected_head" ]; then',
    '  echo "PR branch ${feature_branch} moved: expected ${expected_head}, found ${current_head}. Refusing repair publish." >&2',
    '  exit 42',
    'fi',
    'if ! git merge-base --is-ancestor "$expected_head" HEAD; then',
    '  echo "Repair head is not a descendant of captured PR head ${expected_head}. Refusing repair publish." >&2',
    '  exit 43',
    'fi',
    'git branch -f "$repair_branch" HEAD',
    'git push --force-with-lease "$remote" "HEAD:refs/heads/${repair_branch}"',
    'git push "$remote" "HEAD:refs/heads/${feature_branch}"',
  ].join('\n');
}

export function submitRepairWorkflowFromCiFailure(
  options: RepairWorkflowSpawnOptions,
  payload: SpawnRepairWorkflowCommandPayload,
): RepairWorkflowSpawnResult {
  const actionKey = repairWorkflowActionKey({ ...payload.event, headSha: payload.prHeadSha });
  const task = loadTaskForEvent(options.store, payload.event);
  if (!task) {
    logRepairWorkflowEvent(options, payload.event, 'repair-workflow-skip', { reason: 'task-missing' });
    return skipped('task-missing', actionKey);
  }

  const existingAction = getExistingRepairWorkflowAction(options.store, actionKey);
  const usesQueuedWorkerReservation = Boolean(
    payload.queuedByRepairWorkflowGuard
      && existingAction
      && isPendingGuardRow(existingAction),
  );
  if (shouldSkipExistingAction(existingAction, payload)) {
    logRepairWorkflowEvent(options, payload.event, 'repair-workflow-skip', { reason: 'already-recorded' });
    return skipped('already-recorded', actionKey);
  }

  const source = payload.source ?? 'worker';
  if (source !== 'human' && !usesQueuedWorkerReservation) {
    const retryBudget = retryBudgetForTask(task, options);
    const retryCap = checkAutoFixRetryCap(options.store, payload.event.taskId, retryBudget);
    if (!retryCap.allowed) {
      recordRepairWorkflowAction(options.store, payload.event, actionKey, 'skipped', 'Skipped repair workflow because retry budget is exhausted', {
        headSha: payload.prHeadSha,
        reason: 'worker-retry-budget-exhausted',
        workerRetryBudget: retryBudgetLabel(retryCap.budget),
      });
      logRepairWorkflowEvent(options, payload.event, 'repair-workflow-skip', {
        reason: 'worker-retry-budget-exhausted',
        workerRetryBudget: retryBudgetLabel(retryCap.budget),
      });
      return skipped('worker-retry-budget-exhausted', actionKey);
    }
  }

  const upstreamWorkflow = loadWorkflow(options.store, payload.upstreamWorkflowId);
  const repoUrl = requiredString(upstreamWorkflow?.repoUrl, 'repoUrl');
  const agentName = nonEmpty(options.getAutoFixAgent?.());
  const executionModel = nonEmpty(options.getAutoFixExecutionModel?.());
  const spec = buildRepairWorkflowSpec({
    event: payload.event,
    upstreamWorkflowId: payload.upstreamWorkflowId,
    upstreamFeatureBranch: payload.upstreamFeatureBranch,
    prHeadSha: payload.prHeadSha,
    failedCheckNames: payload.failedCheckNames,
    repoUrl,
    intermediateRepoUrl: upstreamWorkflow?.intermediateRepoUrl,
    executionAgent: agentName,
    executionModel,
  });

  const before = new Set(options.orchestrator.getWorkflowIds());
  options.orchestrator.loadPlan(spec, { allowGraphMutation: options.allowGraphMutation });
  const workflowId = options.orchestrator.getWorkflowIds().find((id) => !before.has(id));
  if (!workflowId) {
    throw new Error('Repair workflow submission did not create a workflow.');
  }
  const started = options.orchestrator.startExecution();
  const tasks = options.orchestrator.getAllTasks().filter((candidate) => candidate.config.workflowId === workflowId);

  recordRepairWorkflowAction(options.store, payload.event, actionKey, 'queued', 'Spawned CI repair workflow', {
    channel: SPAWN_REPAIR_WORKFLOW_CHANNEL,
    repairWorkflowId: workflowId,
    repairBranch: spec.featureBranch,
    headSha: payload.prHeadSha,
    failedChecksHash: ciFailureChecksHash(payload.event.failedChecks),
    source,
  }, undefined, { incrementAttempt: !usesQueuedWorkerReservation });
  if (source !== 'human' && !usesQueuedWorkerReservation) {
    recordAutoFixRetryConsumed(options.store, payload.event.taskId, {
      workflowId: payload.event.workflowId,
      summary: 'Durable per-task CI repair workflow spawn counter',
    });
  }
  logRepairWorkflowEvent(options, payload.event, 'repair-workflow-spawned', {
    workflowId,
    repairBranch: spec.featureBranch,
    startedTaskCount: started.length,
  });

  return {
    decision: 'spawned',
    reason: 'spawned',
    workflowId,
    started,
    tasks,
    spec,
    actionKey,
  };
}

export function queueRepairWorkflowSpawn(
  options: QueueRepairWorkflowSpawnOptions,
  event: ReviewGateCiFailedLifecycleEvent,
): QueueRepairWorkflowSpawnResult {
  const actionKey = repairWorkflowActionKey(event);
  const task = loadTaskForEvent(options.store, event);
  if (!task) {
    logRepairWorkflowEvent(options, event, 'repair-workflow-queue-skip', { reason: 'task-missing' });
    return { decision: 'skipped', reason: 'task-missing' };
  }
  if (shouldSkipExistingAction(getExistingRepairWorkflowAction(options.store, actionKey))) {
    logRepairWorkflowEvent(options, event, 'repair-workflow-queue-skip', { reason: 'already-recorded' });
    return { decision: 'skipped', reason: 'already-recorded' };
  }

  const retryBudget = retryBudgetForTask(task, options);
  const retryCap = checkAutoFixRetryCap(options.store, event.taskId, retryBudget);
  if (!retryCap.allowed) {
    recordRepairWorkflowAction(options.store, event, actionKey, 'skipped', 'Skipped repair workflow because retry budget is exhausted', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    });
    logRepairWorkflowEvent(options, event, 'repair-workflow-queue-skip', {
      reason: 'worker-retry-budget-exhausted',
      workerRetryBudget: retryBudgetLabel(retryCap.budget),
    });
    return { decision: 'skipped', reason: 'worker-retry-budget-exhausted' };
  }

  const payload = buildSpawnRepairWorkflowCommandPayload(event, {
    source: 'worker',
    queuedByRepairWorkflowGuard: true,
  });
  const intentId = options.submitter.submit(
    event.workflowId,
    'normal',
    SPAWN_REPAIR_WORKFLOW_CHANNEL,
    [payload],
  );
  recordRepairWorkflowAction(options.store, event, actionKey, 'queued', 'Queued CI repair workflow spawn', {
    channel: SPAWN_REPAIR_WORKFLOW_CHANNEL,
    failedChecksHash: ciFailureChecksHash(event.failedChecks),
  }, intentId);
  recordAutoFixRetryConsumed(options.store, event.taskId, {
    workflowId: event.workflowId,
    summary: 'Durable per-task CI repair workflow spawn counter',
  });
  logRepairWorkflowEvent(options, event, 'repair-workflow-queued', { intentId });
  return { decision: 'queued', reason: 'queued', intentId };
}

function skipped(reason: string, actionKey: string): RepairWorkflowSpawnResult {
  return {
    decision: 'skipped',
    reason,
    started: [],
    tasks: [],
    actionKey,
  };
}

function loadTaskForEvent(
  store: RepairWorkflowSpawnStore,
  event: ReviewGateCiFailedLifecycleEvent,
): TaskState | undefined {
  return store.loadTask?.(event.taskId)
    ?? store.loadTasks(event.workflowId).find((task) => task.id === event.taskId);
}

function loadWorkflow(store: RepairWorkflowSpawnStore, workflowId: string): ReturnType<NonNullable<RepairWorkflowSpawnStore['loadWorkflow']>> {
  return store.loadWorkflow?.(workflowId)
    ?? store.listWorkflows?.().find((workflow) => workflow.id === workflowId);
}

function getExistingRepairWorkflowAction(
  store: RepairWorkflowSpawnStore,
  actionKey: string,
): WorkerActionRecord | undefined {
  return store.getWorkerAction?.(CI_FAILURE_WORKER_KIND, actionKey);
}

function shouldSkipExistingAction(
  existing: WorkerActionRecord | undefined,
  payload?: SpawnRepairWorkflowCommandPayload,
): boolean {
  if (!existing) return false;
  if (payload?.queuedByRepairWorkflowGuard && isPendingGuardRow(existing)) {
    return false;
  }
  return isOpenOrCompletedActionStatus(existing.status);
}

function isPendingGuardRow(existing: WorkerActionRecord): boolean {
  if (existing.actionType !== REPAIR_WORKFLOW_ACTION_TYPE || existing.status !== 'queued') return false;
  const payload = existing.payload && typeof existing.payload === 'object'
    ? existing.payload as Record<string, unknown>
    : {};
  return payload.channel === SPAWN_REPAIR_WORKFLOW_CHANNEL && payload.repairWorkflowId === undefined;
}

function recordRepairWorkflowAction(
  store: RepairWorkflowSpawnStore,
  event: ReviewGateCiFailedLifecycleEvent,
  actionKey: string,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  intentId?: number | string,
  options: { incrementAttempt?: boolean } = {},
): void {
  recordWorkerDecisionRow(store, {
    workerKind: CI_FAILURE_WORKER_KIND,
    actionType: REPAIR_WORKFLOW_ACTION_TYPE,
    externalKey: actionKey,
    subjectType: 'review',
    subjectId: event.reviewId,
    workflowId: event.workflowId,
    taskId: event.taskId,
    status,
    summary,
    incrementAttempt: options.incrementAttempt ?? status === 'queued',
    ...(intentId !== undefined ? { intentId } : {}),
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
      failedChecks: event.failedChecks.map((check) => ({ ...check })),
      ...payload,
    },
  });
}

function logRepairWorkflowEvent(
  options: { store: RepairWorkflowSpawnStore; logger?: Logger },
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
  options.store.logEvent?.(event.taskId, 'debug.ci-repair-workflow', payload);
  options.logger?.debug?.(`[worker:${CI_FAILURE_WORKER_KIND}] ${phase}`, {
    module: 'repair-workflow-spec',
    ...payload,
  });
}

function retryBudgetForTask(
  task: TaskState,
  options: Pick<RepairWorkflowSpawnOptions, 'defaultAutoFixRetries' | 'getRetryBudget'>,
): number {
  return normalizeAutoFixRetryBudget(options.getRetryBudget?.(task) ?? options.defaultAutoFixRetries ?? 0);
}

function retryBudgetLabel(budget: number): number | 'unlimited' {
  return budget === Number.POSITIVE_INFINITY ? 'unlimited' : budget;
}

function isOpenOrCompletedActionStatus(status: string): boolean {
  return status === 'queued'
    || status === 'pending'
    || status === 'running'
    || status === 'needs_input'
    || status === 'review_ready'
    || status === 'completed';
}

function requiredString(value: string | undefined, label: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`${label} is required`);
  return trimmed;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function shortSha(sha: string): string {
  const trimmed = sha.trim();
  return trimmed.length <= 12 ? trimmed : trimmed.slice(0, 12);
}

function sanitizeBranchPath(branch: string): string {
  const withoutPrefix = stripRefsHeadsPrefix(branch);
  const sanitized = withoutPrefix
    .split('/')
    .map((part) => part
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .replace(/\.+$/g, ''))
    .filter(Boolean)
    .join('/');
  return sanitized || 'pr-branch';
}

function stripRefsHeadsPrefix(branch: string): string {
  return branch.trim().replace(/^refs\/heads\//, '');
}

function shellSingleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function formatFailedChecks(failedChecks: readonly ReviewGateFailedCheck[]): string {
  return failedChecks
    .map((check) => {
      const conclusion = check.conclusion ? ` (${check.conclusion})` : '';
      const details = check.detailsUrl ? ` - ${check.detailsUrl}` : '';
      return `- ${check.name}${conclusion}${details}`;
    })
    .join('\n');
}

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 2 * 60_000;

const REFRESH_ACTION_TYPE = 'refresh-pr-summary';
type ReviewGateArtifact = NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number];

export interface PrSummaryRefreshWorkflow {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): PrSummaryRefreshWorkflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workflowId?: string; taskId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  mergeGateProvider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  cwd?: string;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  store?: PrSummaryRefreshWorkerStore;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions {
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  cwd?: string;
  logger: Logger;
}

export interface PrSummaryRefreshTarget {
  workflowId: string;
  mergeTask: TaskState;
  reviewId: string;
  reviewUrl?: string;
  provider?: string;
  title?: string;
  branch?: string;
  baseBranch?: string;
  generation: number;
  cwd: string;
  externalKey: string;
}

function workflowIdForTask(task: TaskState): string | undefined {
  return task.config.workflowId ?? task.id.split('/')[0];
}

function isMergeTask(task: TaskState): boolean {
  return task.config.isMergeNode === true || task.config.runnerKind === 'merge';
}

function hasActionableMergeTaskStatus(task: TaskState): boolean {
  return task.status === 'review_ready'
    || task.status === 'awaiting_approval'
    || task.status === 'completed';
}

function isActiveArtifact(artifact: ReviewGateArtifact, activeGeneration: number): boolean {
  return artifact.generation === activeGeneration
    && artifact.status !== 'discarded'
    && !artifact.discardedAt;
}

function providerMatches(
  artifactProvider: string | undefined,
  provider: Pick<MergeGateProvider, 'name'> | undefined,
): boolean {
  if (!artifactProvider || !provider?.name) return true;
  return artifactProvider === provider.name;
}

function normalizeForCompare(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function actionReason(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined;
}

function workerActionForContext(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(actionReason(action) ? { reason: actionReason(action) } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function taskEntryForContext(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
    ...(task.config.summary ? { fileChangeSummary: task.config.summary } : {}),
  };
}

function buildStructuredContext(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringContext {
  const workflow = store.loadWorkflow?.(workflowId);
  const tasks = store.loadTasks(workflowId).filter((task) => !task.config.isMergeNode);
  const workerActions = (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(workerActionForContext);
  return {
    ...(workflow?.name ? { workflowName: workflow.name } : {}),
    ...(workflow?.description ? { workflowDescription: workflow.description } : {}),
    tasks: tasks.map(taskEntryForContext),
    ...(workerActions.length > 0 ? { workerActions } : {}),
  };
}

function buildPrSummaryBody(
  store: PrSummaryRefreshWorkerStore,
  target: PrSummaryRefreshTarget,
): string {
  const workflow = store.loadWorkflow?.(target.workflowId);
  const summaryTask = target.mergeTask.config.summary?.trim();
  const workflowSummary = summaryTask
    || workflow?.description?.trim()
    || target.mergeTask.description
    || workflow?.name
    || target.workflowId;
  return buildCanonicalPrBody({
    title: target.title ?? workflow?.name ?? target.mergeTask.description,
    workflowSummary,
    structuredContext: buildStructuredContext(store, target.workflowId),
  });
}

function targetFromArtifact(
  task: TaskState,
  workflowId: string,
  artifact: ReviewGateArtifact,
  cwd: string,
): PrSummaryRefreshTarget | undefined {
  if (!artifact.providerId) return undefined;
  return {
    workflowId,
    mergeTask: task,
    reviewId: artifact.providerId,
    ...(artifact.url ? { reviewUrl: artifact.url } : {}),
    ...(artifact.provider ? { provider: artifact.provider } : {}),
    ...(artifact.title ? { title: artifact.title } : {}),
    ...(artifact.branch ? { branch: artifact.branch } : {}),
    ...(artifact.baseBranch ? { baseBranch: artifact.baseBranch } : {}),
    generation: artifact.generation,
    cwd,
    externalKey: [
      task.id,
      artifact.providerId,
      `g${artifact.generation}`,
    ].join(':'),
  };
}

export function listPrSummaryRefreshTargets(
  store: PrSummaryRefreshWorkerStore,
  options: { cwd?: string; provider?: Pick<MergeGateProvider, 'name'> } = {},
): PrSummaryRefreshTarget[] {
  const targets: PrSummaryRefreshTarget[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (!isMergeTask(task) || !hasActionableMergeTaskStatus(task)) continue;
      const workflowId = workflowIdForTask(task);
      if (!workflowId) continue;
      const cwd = task.execution.workspacePath ?? options.cwd ?? process.cwd();
      const reviewGate = task.execution.reviewGate;
      const activeGeneration = reviewGate?.activeGeneration ?? task.execution.generation ?? 0;
      const activeArtifacts = reviewGate?.artifacts
        .filter((artifact) => isActiveArtifact(artifact, activeGeneration))
        .filter((artifact) => providerMatches(artifact.provider, options.provider))
        ?? [];

      if (activeArtifacts.length > 0) {
        for (const artifact of activeArtifacts) {
          const target = targetFromArtifact(task, workflowId, artifact, cwd);
          if (target) targets.push(target);
        }
        continue;
      }

      if (!task.execution.reviewId) continue;
      targets.push({
        workflowId,
        mergeTask: task,
        reviewId: task.execution.reviewId,
        ...(task.execution.reviewUrl ? { reviewUrl: task.execution.reviewUrl } : {}),
        generation: task.execution.generation ?? 0,
        cwd,
        externalKey: [
          task.id,
          task.execution.reviewId,
          `g${task.execution.generation ?? 0}`,
        ].join(':'),
      });
    }
  }
  return targets;
}

function logWorkerActionEvent(
  store: PrSummaryRefreshWorkerStore,
  target: PrSummaryRefreshTarget,
  action: WorkerActionRecord | undefined,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): void {
  store.logEvent?.(target.mergeTask.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: REFRESH_ACTION_TYPE,
    status,
    summary,
    workflowId: target.workflowId,
    reviewId: target.reviewId,
    reviewUrl: target.reviewUrl ?? null,
    externalKey: target.externalKey,
    actionId: action?.id ?? null,
    ...payload,
  });
}

function recordRefreshAction(
  options: PrSummaryRefreshTickOptions,
  target: PrSummaryRefreshTarget,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
): WorkerActionRecord | undefined {
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: REFRESH_ACTION_TYPE,
    externalKey: target.externalKey,
    subjectType: 'review',
    subjectId: target.reviewId,
    workflowId: target.workflowId,
    taskId: target.mergeTask.id,
    status,
    summary,
    incrementAttempt: status === 'completed' || status === 'failed',
    payload: {
      provider: target.provider ?? options.mergeGateProvider?.name ?? null,
      reviewId: target.reviewId,
      reviewUrl: target.reviewUrl ?? null,
      branch: target.branch ?? null,
      baseBranch: target.baseBranch ?? null,
      generation: target.generation,
      ...payload,
    },
  });
  logWorkerActionEvent(options.store, target, action, status, summary, payload);
  return action;
}

async function refreshTarget(
  options: PrSummaryRefreshTickOptions,
  target: PrSummaryRefreshTarget,
): Promise<void> {
  const provider = options.mergeGateProvider;
  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordRefreshAction(options, target, 'skipped', 'Skipped PR summary refresh; provider cannot update PR bodies', {
      reason: 'provider-update-unavailable',
    });
    return;
  }

  if (!providerMatches(target.provider, provider)) {
    recordRefreshAction(options, target, 'skipped', 'Skipped PR summary refresh for a different provider', {
      reason: 'provider-mismatch',
      provider: provider.name,
      artifactProvider: target.provider ?? null,
    });
    return;
  }

  try {
    const nextBody = buildPrSummaryBody(options.store, target);
    const currentBody = await provider.getReviewBody({ identifier: target.reviewId, cwd: target.cwd });
    if (normalizeForCompare(currentBody) === normalizeForCompare(nextBody)) {
      recordRefreshAction(options, target, 'skipped', 'PR summary already up to date', {
        reason: 'unchanged',
        bodyLength: nextBody.length,
      });
      return;
    }

    await provider.updateReviewBody({ identifier: target.reviewId, cwd: target.cwd, body: nextBody });
    recordRefreshAction(options, target, 'completed', 'Refreshed PR summary body', {
      bodyLength: nextBody.length,
    });
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    recordRefreshAction(options, target, 'failed', `PR summary refresh failed: ${error}`, {
      reason: 'provider-error',
      error,
    });
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] refresh failed`, {
      module: 'pr-summary-refresh-worker',
      taskId: target.mergeTask.id,
      workflowId: target.workflowId,
      reviewId: target.reviewId,
      error,
    });
  }
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    const targets = listPrSummaryRefreshTargets(options.store, {
      cwd: options.cwd,
      provider: options.mergeGateProvider,
    });
    const seen = new Set<string>();
    for (const target of targets) {
      if (seen.has(target.externalKey)) continue;
      seen.add(target.externalKey);
      await refreshTarget(options, target);
    }
  };
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.store
        ? createPrSummaryRefreshTick({
          store: options.store,
          mergeGateProvider: options.mergeGateProvider,
          cwd: options.cwd,
          logger: options.logger,
        })
        : (() => {})
    ),
  });
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the latest Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        mergeGateProvider: deps.prSummaryRefresh?.mergeGateProvider,
        cwd: deps.prSummaryRefresh?.cwd,
        intervalMs: deps.prSummaryRefresh?.intervalMs,
      }),
  });
  return registry;
}

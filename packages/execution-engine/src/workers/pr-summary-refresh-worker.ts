import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

type ReviewArtifact = NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number];

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<Workflow>;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions(filters?: { workflowId?: string; taskId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  /** Poll cadence for the owner runtime. Defaults to one minute. */
  intervalMs?: number;
  /** Fallback cwd for provider calls when the merge task has no workspacePath. */
  cwd?: string;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: MergeGateProvider;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: MergeGateProvider;
}

interface RefreshTarget {
  workflow: Workflow;
  mergeTask: TaskState;
  artifact: ReviewArtifact;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes published PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        mergeGateProvider: deps.mergeGateProvider,
        ...deps.prSummaryRefresh,
      }),
  });
  return registry;
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrSummaryRefreshTick({
      logger: options.logger,
      store: options.store,
      mergeGateProvider: options.mergeGateProvider,
      cwd: options.cwd,
      intervalMs: options.intervalMs,
    }),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    const targets = collectRefreshTargets(options.store);
    if (targets.length === 0) return;

    for (const target of targets) {
      await refreshTarget(options, target);
    }
  };
}

export function buildPrSummaryRefreshBody(args: {
  workflow: Workflow;
  tasks: readonly TaskState[];
  mergeTask: TaskState;
  workerActions: readonly WorkerActionRecord[];
}): string {
  const context: PrAuthoringContext = {
    workflowName: args.workflow.name,
    workflowDescription: args.workflow.description,
    tasks: args.tasks
      .filter((task) => !task.config.isMergeNode)
      .map(toPrTaskEntry),
    workerActions: args.workerActions
      .map(toPrWorkerActionEntry)
      .filter((action): action is PrAuthoringWorkerActionEntry => action !== undefined),
  };

  return buildCanonicalPrBody({
    title: args.workflow.name,
    workflowSummary: args.mergeTask.config.summary ?? args.workflow.description ?? args.workflow.name,
    structuredContext: context,
  });
}

function collectRefreshTargets(store: PrSummaryRefreshWorkerStore): RefreshTarget[] {
  const targets: RefreshTarget[] = [];
  for (const workflow of store.listWorkflows()) {
    const tasks = store.loadTasks(workflow.id);
    for (const mergeTask of tasks) {
      if (!mergeTask.config.isMergeNode) continue;
      for (const artifact of getCurrentReviewArtifacts(mergeTask)) {
        if (!artifact.providerId) continue;
        if (artifact.status === 'closed' || artifact.status === 'merged' || artifact.status === 'discarded') continue;
        targets.push({ workflow, mergeTask, artifact });
      }
    }
  }
  return targets;
}

async function refreshTarget(
  options: PrSummaryRefreshTickOptions,
  target: RefreshTarget,
): Promise<void> {
  const provider = options.mergeGateProvider;
  const providerId = target.artifact.providerId;
  if (!providerId) return;

  const providerName = provider?.name ?? target.artifact.provider ?? 'unknown';
  const externalKey = [
    target.workflow.id,
    target.mergeTask.id,
    providerName,
    providerId,
    target.artifact.generation,
  ].join(':');

  if (target.artifact.provider && provider && target.artifact.provider !== provider.name) {
    recordRefreshAction(options.store, {
      target,
      externalKey,
      status: 'skipped',
      summary: `Skipped PR summary refresh for provider ${target.artifact.provider}`,
      reason: 'provider-mismatch',
      payload: { provider: target.artifact.provider, configuredProvider: provider.name, providerId },
    });
    return;
  }

  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordRefreshAction(options.store, {
      target,
      externalKey,
      status: 'skipped',
      summary: 'Skipped PR summary refresh because provider body update is unavailable',
      reason: 'provider-update-unavailable',
      payload: { provider: providerName, providerId },
    });
    return;
  }

  const tasks = options.store.loadTasks(target.workflow.id);
  const body = buildPrSummaryRefreshBody({
    workflow: target.workflow,
    tasks,
    mergeTask: target.mergeTask,
    workerActions: options.store.listWorkerActions({ workflowId: target.workflow.id }),
  });
  const cwd = target.mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();

  try {
    const current = await provider.getReviewBody({ identifier: providerId, cwd });
    if (normalizeBodyForComparison(current) === normalizeBodyForComparison(body)) {
      recordRefreshAction(options.store, {
        target,
        externalKey,
        status: 'skipped',
        summary: 'PR summary already current',
        reason: 'body-current',
        payload: { provider: provider.name, providerId, reviewUrl: target.artifact.url },
      });
      return;
    }

    recordRefreshAction(options.store, {
      target,
      externalKey,
      status: 'running',
      summary: 'Refreshing PR summary body',
      payload: { provider: provider.name, providerId, reviewUrl: target.artifact.url },
      incrementAttempt: true,
    });
    await provider.updateReviewBody({ identifier: providerId, cwd, body });
    recordRefreshAction(options.store, {
      target,
      externalKey,
      status: 'completed',
      summary: 'Refreshed PR summary body',
      payload: { provider: provider.name, providerId, reviewUrl: target.artifact.url },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR ${providerId}`, {
      module: 'pr-summary-refresh-worker',
      workflowId: target.workflow.id,
      taskId: target.mergeTask.id,
      providerId,
      err,
    });
    recordRefreshAction(options.store, {
      target,
      externalKey,
      status: 'failed',
      summary: `Failed to refresh PR summary body: ${message}`,
      reason: 'provider-error',
      payload: { provider: provider.name, providerId, reviewUrl: target.artifact.url, error: message },
      incrementAttempt: true,
    });
  }
}

function recordRefreshAction(
  store: PrSummaryRefreshWorkerStore,
  args: {
    target: RefreshTarget;
    externalKey: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    payload?: Record<string, unknown>;
    incrementAttempt?: boolean;
  },
): void {
  const row: WorkerDecisionRow = {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'review-body-refresh',
    externalKey: args.externalKey,
    subjectType: 'pull_request',
    subjectId: args.target.artifact.providerId ?? args.target.artifact.id,
    workflowId: args.target.workflow.id,
    taskId: args.target.mergeTask.id,
    status: args.status,
    summary: args.summary,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.payload ? { payload: args.payload } : {}),
    ...(args.incrementAttempt !== undefined ? { incrementAttempt: args.incrementAttempt } : {}),
  };
  const record = recordWorkerDecisionRow(store, row);
  store.logEvent?.(args.target.mergeTask.id, 'task.worker_action', {
    workerActionId: record?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${args.externalKey}`,
    workerKind: row.workerKind,
    actionType: row.actionType,
    status: row.status,
    summary: row.summary,
    ...(row.reason ? { reason: row.reason } : {}),
    workflowId: row.workflowId,
    taskId: row.taskId,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    externalKey: row.externalKey,
    ...args.payload,
  });
}

function toPrTaskEntry(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function toPrWorkerActionEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry | undefined {
  if (action.workerKind === PR_SUMMARY_REFRESH_WORKER_KIND) return undefined;
  const reason = extractReason(action.payload);
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function getCurrentReviewArtifacts(task: TaskState): ReviewArtifact[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts.filter((artifact) =>
      artifact.generation === gate.activeGeneration
      && artifact.status !== 'discarded'
      && !artifact.discardedAt);
  }

  if (!task.execution.reviewId) return [];
  return [{
    id: task.execution.reviewId,
    providerId: task.execution.reviewId,
    url: task.execution.reviewUrl,
    branch: task.execution.branch,
    required: true,
    status: 'open',
    generation: task.execution.generation ?? 0,
  }];
}

function extractReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function normalizeBodyForComparison(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

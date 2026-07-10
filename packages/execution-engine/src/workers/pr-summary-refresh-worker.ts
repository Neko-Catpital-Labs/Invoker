import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionListFilters, WorkerActionRecord, WorkerActionStatus } from '@invoker/data-store';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type WorkflowSummary = {
  id: string;
  name?: string;
  description?: string;
  repoUrl?: string;
};

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<WorkflowSummary>;
  loadWorkflow?(workflowId: string): WorkflowSummary | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  provider?: MergeGateProvider;
  cwd?: string;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store?: PrSummaryRefreshWorkerStore;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store?: PrSummaryRefreshWorkerStore;
}

interface ReviewTarget {
  identifier: string;
  url?: string;
  title?: string;
  provider?: string;
  generation: number;
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
        provider: deps.prSummaryRefresh?.provider,
        cwd: deps.prSummaryRefresh?.cwd,
        intervalMs: deps.prSummaryRefresh?.intervalMs,
      }),
  });
  return registry;
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    await refreshPublishedPrSummaries(options);
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
    onTick: options.onTick ?? createPrSummaryRefreshTick({
      logger: options.logger,
      store: options.store,
      provider: options.provider,
      cwd: options.cwd,
      intervalMs: options.intervalMs,
    }),
  });
}

export async function refreshPublishedPrSummaries(options: PrSummaryRefreshTickOptions): Promise<void> {
  const store = options.store;
  if (!store) {
    options.logger.debug?.('[worker:pr-summary-refresh] store dependency unavailable', {
      module: 'pr-summary-refresh-worker',
    });
    return;
  }

  for (const listedWorkflow of store.listWorkflows()) {
    const workflow = store.loadWorkflow?.(listedWorkflow.id) ?? listedWorkflow;
    const tasks = store.loadTasks(workflow.id);
    const mergeTasks = tasks.filter((task) => task.config.isMergeNode);
    for (const mergeTask of mergeTasks) {
      const targets = reviewTargetsForMergeTask(mergeTask);
      for (const target of targets) {
        await refreshOneTarget(options, store, workflow, tasks, mergeTask, target);
      }
    }
  }
}

async function refreshOneTarget(
  options: PrSummaryRefreshTickOptions,
  store: PrSummaryRefreshWorkerStore,
  workflow: WorkflowSummary,
  tasks: readonly TaskState[],
  mergeTask: TaskState,
  target: ReviewTarget,
): Promise<void> {
  const provider = options.provider;
  const externalKey = `${workflow.id}:${mergeTask.id}:${target.identifier}:g${target.generation}`;
  const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();

  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordAction(store, mergeTask.id, {
      externalKey,
      workflowId: workflow.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'skipped',
      summary: 'Skipped PR summary refresh because review body update is unavailable',
      reason: 'provider-update-unavailable',
    });
    return;
  }

  if (target.provider && target.provider !== provider.name) {
    recordAction(store, mergeTask.id, {
      externalKey,
      workflowId: workflow.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'skipped',
      summary: `Skipped PR summary refresh for ${target.provider} review`,
      reason: 'provider-mismatch',
    });
    return;
  }

  const body = buildCanonicalPrBody({
    title: target.title ?? workflow.name ?? 'Workflow',
    workflowSummary: mergeTask.config.summary ?? workflow.description ?? workflow.name ?? workflow.id,
    structuredContext: buildStructuredContext(store, workflow, tasks),
  });
  const bodySha = createHash('sha256').update(body).digest('hex');

  try {
    const currentBody = await provider.getReviewBody({ identifier: target.identifier, cwd });
    if (currentBody.trim() === body.trim()) {
      recordAction(store, mergeTask.id, {
        externalKey,
        workflowId: workflow.id,
        reviewId: target.identifier,
        reviewUrl: target.url,
        status: 'skipped',
        summary: 'PR summary already current',
        reason: 'body-unchanged',
        payload: { bodySha },
      });
      return;
    }

    await provider.updateReviewBody({ identifier: target.identifier, cwd, body });
    recordAction(store, mergeTask.id, {
      externalKey,
      workflowId: workflow.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'completed',
      summary: 'Updated PR pipeline summary',
      incrementAttempt: true,
      payload: { bodySha },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.warn('[worker:pr-summary-refresh] PR summary refresh failed', {
      module: 'pr-summary-refresh-worker',
      workflowId: workflow.id,
      taskId: mergeTask.id,
      reviewId: target.identifier,
      err,
    });
    recordAction(store, mergeTask.id, {
      externalKey,
      workflowId: workflow.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'failed',
      summary: 'Failed to update PR pipeline summary',
      reason: message,
      payload: { bodySha },
    });
  }
}

function buildStructuredContext(
  store: PrSummaryRefreshWorkerStore,
  workflow: WorkflowSummary,
  tasks: readonly TaskState[],
): PrAuthoringContext {
  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks: tasks
      .filter((task) => !task.config.isMergeNode)
      .map(taskToPrAuthoringEntry),
    workerActions: (store.listWorkerActions?.({ workflowId: workflow.id }) ?? [])
      .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
      .map(workerActionToPrEntry),
  };
}

function taskToPrAuthoringEntry(task: TaskState): PrAuthoringTaskEntry {
  const status: PrAuthoringTaskEntry['status'] =
    task.status === 'completed' ? 'completed'
      : task.status === 'failed' ? 'failed'
        : 'skipped';
  return {
    taskId: task.id,
    description: task.description,
    status,
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function workerActionToPrEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload as Record<string, unknown>
    : {};
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function reviewTargetsForMergeTask(task: TaskState): ReviewTarget[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts
      .filter((artifact) => artifact.generation === gate.activeGeneration)
      .filter((artifact) => artifact.status !== 'discarded')
      .filter((artifact) => typeof artifact.providerId === 'string' && artifact.providerId.trim().length > 0)
      .map((artifact) => ({
        identifier: artifact.providerId!,
        url: artifact.url,
        title: artifact.title,
        provider: artifact.provider,
        generation: artifact.generation,
      }));
  }
  if (task.execution.reviewId) {
    return [{
      identifier: task.execution.reviewId,
      url: task.execution.reviewUrl,
      title: task.description,
      provider: task.execution.reviewProviderId,
      generation: task.execution.generation ?? 0,
    }];
  }
  return [];
}

function recordAction(
  store: PrSummaryRefreshWorkerStore,
  mergeTaskId: string,
  args: {
    externalKey: string;
    workflowId: string;
    reviewId: string;
    reviewUrl?: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    incrementAttempt?: boolean;
    payload?: Record<string, unknown>;
  },
): void {
  const record = recordWorkerDecisionRow(store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: args.externalKey,
    workflowId: args.workflowId,
    taskId: mergeTaskId,
    subjectType: 'pull_request',
    subjectId: args.reviewId,
    status: args.status,
    summary: args.summary,
    reason: args.reason,
    incrementAttempt: args.incrementAttempt,
    payload: {
      reviewId: args.reviewId,
      ...(args.reviewUrl ? { reviewUrl: args.reviewUrl } : {}),
      ...args.payload,
    },
  });

  store.logEvent?.(mergeTaskId, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: args.status,
    summary: args.summary,
    message: args.summary,
    reviewId: args.reviewId,
    ...(args.reviewUrl ? { reviewUrl: args.reviewUrl } : {}),
    ...(args.reason ? { reason: args.reason } : {}),
    ...(record ? { workerActionId: record.id } : {}),
  });
}

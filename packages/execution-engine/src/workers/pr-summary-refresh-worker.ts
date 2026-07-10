import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

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
import { getCurrentRequiredReviewArtifacts } from '../task-runner-review-gate.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<{ id: string; name?: string; description?: string }>;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: { workflowId?: string; taskId?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  intervalMs?: number;
  cwd?: string;
}

export interface PrSummaryRefreshWorkerPolicyOptions extends PrSummaryRefreshWorkerConfig {
  store: PrSummaryRefreshWorkerStore;
  provider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerPolicyOptions {
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review-gate PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        provider: deps.mergeGateProvider,
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
    onTick: options.onTick ?? createPrSummaryRefreshTick(options),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshWorkerPolicyOptions): Promise<void> {
  const provider = options.provider;
  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] merge-gate body update provider unavailable`, {
      module: 'pr-summary-refresh-worker',
    });
    return;
  }

  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    const mergeTasks = tasks.filter(isRefreshableMergeTask);
    for (const mergeTask of mergeTasks) {
      const artifacts = getCurrentRequiredReviewArtifacts(mergeTask);
      for (const artifact of artifacts) {
        if (!artifact.providerId) continue;
        const externalKey = [
          workflow.id,
          mergeTask.id,
          provider.name,
          artifact.providerId,
          artifact.generation,
        ].join(':');
        const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
        try {
          recordRefreshAction(options, {
            externalKey,
            workflowId: workflow.id,
            taskId: mergeTask.id,
            providerId: artifact.providerId,
            reviewUrl: artifact.url ?? mergeTask.execution.reviewUrl,
            status: 'running',
            summary: 'Checking PR body pipeline summary',
            incrementAttempt: true,
          });

          const context = buildWorkerPrAuthoringContext({
            workflow,
            tasks,
            workerActions: collectWorkflowWorkerActions(options.store, workflow.id, tasks),
          });
          const body = buildCanonicalPrBody({
            title: workflow.name ?? mergeTask.description,
            workflowSummary: mergeTask.config.summary ?? workflow.description ?? workflow.name ?? mergeTask.description,
            structuredContext: context,
          });
          const current = await provider.getReviewBody({ identifier: artifact.providerId, cwd });
          if (normalizeBody(current) === normalizeBody(body)) {
            recordRefreshAction(options, {
              externalKey,
              workflowId: workflow.id,
              taskId: mergeTask.id,
              providerId: artifact.providerId,
              reviewUrl: artifact.url ?? mergeTask.execution.reviewUrl,
              status: 'skipped',
              summary: 'PR body already has the current pipeline summary',
              reason: 'body-current',
            });
            continue;
          }

          await provider.updateReviewBody({ identifier: artifact.providerId, cwd, body });
          recordRefreshAction(options, {
            externalKey,
            workflowId: workflow.id,
            taskId: mergeTask.id,
            providerId: artifact.providerId,
            reviewUrl: artifact.url ?? mergeTask.execution.reviewUrl,
            status: 'completed',
            summary: `Updated PR body with ${context.workerActions?.length ?? 0} worker action(s)`,
            payload: { bodyChanged: true },
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] PR body refresh failed`, {
            module: 'pr-summary-refresh-worker',
            workflowId: workflow.id,
            taskId: mergeTask.id,
            providerId: artifact.providerId,
            err,
          });
          recordRefreshAction(options, {
            externalKey,
            workflowId: workflow.id,
            taskId: mergeTask.id,
            providerId: artifact.providerId,
            reviewUrl: artifact.url ?? mergeTask.execution.reviewUrl,
            status: 'failed',
            summary: 'Failed to refresh PR body pipeline summary',
            reason: 'provider-update-failed',
            payload: { error: message },
          });
        }
      }
    }
  }
}

function isRefreshableMergeTask(task: TaskState): boolean {
  return Boolean(
    task.config.isMergeNode
    && (task.status === 'review_ready' || task.status === 'awaiting_approval')
    && getCurrentRequiredReviewArtifacts(task).length > 0,
  );
}

function buildWorkerPrAuthoringContext(args: {
  workflow: { name?: string; description?: string };
  tasks: readonly TaskState[];
  workerActions: readonly PrAuthoringWorkerActionEntry[];
}): PrAuthoringContext {
  return {
    workflowName: args.workflow.name,
    workflowDescription: args.workflow.description,
    tasks: args.tasks
      .filter((task) => !task.config.isMergeNode)
      .map(toPrAuthoringTaskEntry),
    workerActions: args.workerActions,
  };
}

function toPrAuthoringTaskEntry(task: TaskState): PrAuthoringTaskEntry {
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

function collectWorkflowWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
  tasks: readonly TaskState[],
): PrAuthoringWorkerActionEntry[] {
  const taskIds = new Set(tasks.map((task) => task.id));
  const byId = new Map<string, WorkerActionRecord>();
  for (const action of store.listWorkerActions?.({ workflowId }) ?? []) {
    byId.set(action.id, action);
  }
  for (const task of tasks) {
    for (const action of store.listWorkerActions?.({ taskId: task.id }) ?? []) {
      byId.set(action.id, action);
    }
  }

  return [...byId.values()]
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .filter((action) => action.workflowId === workflowId || (action.taskId ? taskIds.has(action.taskId) : false))
    .map((action) => ({
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      ...(action.taskId ? { taskId: action.taskId } : {}),
      ...(action.summary ? { summary: action.summary } : {}),
      ...(workerActionReason(action) ? { reason: workerActionReason(action) } : {}),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
    }));
}

function workerActionReason(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function recordRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  row: {
    externalKey: string;
    workflowId: string;
    taskId: string;
    providerId: string;
    reviewUrl?: string;
    status: WorkerActionWrite['status'];
    summary: string;
    reason?: string;
    incrementAttempt?: boolean;
    payload?: Record<string, unknown>;
  },
): WorkerActionRecord | undefined {
  const saved = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: row.externalKey,
    workflowId: row.workflowId,
    taskId: row.taskId,
    subjectType: 'pull_request',
    subjectId: row.providerId,
    status: row.status,
    summary: row.summary,
    reason: row.reason,
    incrementAttempt: row.incrementAttempt,
    payload: {
      providerId: row.providerId,
      ...(row.reviewUrl ? { reviewUrl: row.reviewUrl } : {}),
      ...row.payload,
    },
  });
  options.store.logEvent?.(row.taskId, 'task.worker_action', {
    actionId: saved?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${row.externalKey}`,
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: row.status,
    summary: row.summary,
    ...(row.reason ? { reason: row.reason } : {}),
    providerId: row.providerId,
    ...(row.reviewUrl ? { reviewUrl: row.reviewUrl } : {}),
  });
  return saved;
}

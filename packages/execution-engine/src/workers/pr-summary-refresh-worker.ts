import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
import type { MergeGateProvider } from '../merge-gate-provider.js';
import { buildCanonicalPrBody, type PrAuthoringContext, type PrAuthoringWorkerActionEntry } from '../pr-authoring.js';
import { getCurrentReviewArtifacts } from '../task-runner-review-gate.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workflowId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  provider?: MergeGateProvider;
  cwd?: string;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes external-review PR bodies with canonical Invoker pipeline summaries.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
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

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshWorkerOptions): Promise<void> {
  const provider = options.provider ?? new GitHubMergeGateProvider();
  if (!provider.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] provider cannot read/update review bodies', {
      module: 'pr-summary-refresh-worker',
      provider: provider.name,
    });
    return;
  }
  const bodyProvider: Required<Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>> = {
    name: provider.name,
    getReviewBody: (opts) => provider.getReviewBody!(opts),
    updateReviewBody: (opts) => provider.updateReviewBody!(opts),
  };

  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    const mergeTasks = tasks.filter((task) =>
      task.config.isMergeNode
      && (task.status === 'review_ready' || task.status === 'awaiting_approval')
    );
    for (const task of mergeTasks) {
      await refreshTaskPrSummaries(options, bodyProvider, workflow.id, task, tasks);
    }
  }
}

async function refreshTaskPrSummaries(
  options: PrSummaryRefreshWorkerOptions,
  provider: Required<Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>>,
  workflowId: string,
  task: TaskState,
  workflowTasks: readonly TaskState[],
): Promise<void> {
  const artifacts = getCurrentReviewArtifacts(task).filter((artifact) =>
    artifact.required
    && artifact.providerId
    && (!artifact.provider || artifact.provider === provider.name)
  );
  for (const artifact of artifacts) {
    const providerId = artifact.providerId;
    if (!providerId) continue;
    const body = buildPrSummaryBody(options.store, workflowId, task, workflowTasks);
    const bodyHash = sha256(body);
    const externalKey = [
      PR_SUMMARY_REFRESH_WORKER_KIND,
      workflowId,
      task.id,
      provider.name,
      providerId,
    ].join(':');
    const cwd = task.execution.workspacePath ?? options.cwd ?? process.cwd();
    let recordedRunning = false;

    try {
      const currentBody = await provider.getReviewBody({ identifier: providerId, cwd });
      if (normalizePrBody(currentBody) === normalizePrBody(body)) {
        recordPrSummaryRefreshAction(options, {
          externalKey,
          workflowId,
          taskId: task.id,
          providerId,
          reviewUrl: artifact.url,
          bodyHash,
          status: 'skipped',
          summary: 'PR summary already current',
          reason: 'up-to-date',
        });
        continue;
      }

      recordPrSummaryRefreshAction(options, {
        externalKey,
        workflowId,
        taskId: task.id,
        providerId,
        reviewUrl: artifact.url,
        bodyHash,
        status: 'running',
        summary: 'Refreshing PR summary',
        incrementAttempt: true,
      });
      recordedRunning = true;
      await provider.updateReviewBody({ identifier: providerId, cwd, body });
      recordPrSummaryRefreshAction(options, {
        externalKey,
        workflowId,
        taskId: task.id,
        providerId,
        reviewUrl: artifact.url,
        bodyHash,
        status: 'completed',
        summary: 'Refreshed PR summary',
        logEvent: true,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR summary`, {
        module: 'pr-summary-refresh-worker',
        workflowId,
        taskId: task.id,
        providerId,
        err,
      });
      recordPrSummaryRefreshAction(options, {
        externalKey,
        workflowId,
        taskId: task.id,
        providerId,
        reviewUrl: artifact.url,
        bodyHash,
        status: 'failed',
        summary: `PR summary refresh failed: ${message}`,
        reason: 'provider-error',
        error: message,
        incrementAttempt: !recordedRunning,
        logEvent: true,
      });
    }
  }
}

function buildPrSummaryBody(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
  mergeTask: TaskState,
  workflowTasks: readonly TaskState[],
): string {
  const context: PrAuthoringContext = {
    workflowDescription: mergeTask.config.summary ?? mergeTask.description,
    tasks: workflowTasks
      .filter((task) => !task.config.isMergeNode)
      .map((task) => ({
        taskId: task.id,
        description: task.description,
        status: task.status === 'completed'
          ? 'completed'
          : task.status === 'failed'
            ? 'failed'
            : 'skipped',
        ...(task.config.command ? { command: task.config.command } : {}),
      })),
    workerActions: collectPrBodyWorkerActions(store, workflowId),
  };

  return buildCanonicalPrBody({
    title: mergeTask.description,
    workflowSummary: mergeTask.config.summary ?? mergeTask.description,
    structuredContext: context,
  });
}

function collectPrBodyWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  return (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((action) => ({
      id: action.id,
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      ...(action.taskId ? { taskId: action.taskId } : {}),
      subjectType: action.subjectType,
      subjectId: action.subjectId,
      ...(action.summary ? { summary: action.summary } : {}),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
    }));
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshWorkerOptions,
  args: {
    externalKey: string;
    workflowId: string;
    taskId: string;
    providerId: string;
    reviewUrl?: string;
    bodyHash: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    error?: string;
    incrementAttempt?: boolean;
    logEvent?: boolean;
  },
): WorkerActionRecord | undefined {
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: args.externalKey,
    subjectType: 'review',
    subjectId: args.providerId,
    workflowId: args.workflowId,
    taskId: args.taskId,
    status: args.status,
    summary: args.summary,
    reason: args.reason,
    incrementAttempt: args.incrementAttempt,
    payload: {
      reviewId: args.providerId,
      reviewUrl: args.reviewUrl ?? null,
      bodyHash: args.bodyHash,
      ...(args.error ? { error: args.error } : {}),
    },
  });

  if (args.logEvent) {
    options.store.logEvent?.(args.taskId, 'task.worker_action', {
      message: args.summary,
      worker: PR_SUMMARY_REFRESH_WORKER_KIND,
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
      status: args.status,
      reviewId: args.providerId,
      ...(args.reviewUrl ? { reviewUrl: args.reviewUrl } : {}),
      ...(action?.id ? { workerActionId: action.id } : {}),
      ...(args.reason ? { reason: args.reason } : {}),
    });
  }

  return action;
}

function normalizePrBody(body: string): string {
  return body.replace(/\s+$/u, '');
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

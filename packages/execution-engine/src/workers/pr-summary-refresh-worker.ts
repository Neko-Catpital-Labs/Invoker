import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  isInvokerRepoUrl,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { getCurrentReviewArtifacts } from '../task-runner-review-gate.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;
const PR_SUMMARY_REFRESH_ACTION_TYPE = 'pr-summary-refresh';

export interface PrSummaryRefreshWorkflow {
  id: string;
  name?: string;
  description?: string;
  repoUrl?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflow>;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: { workflowId?: string; taskId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  provider?: MergeGateProvider;
  cwd?: string;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

interface ReviewTarget {
  identifier: string;
  url?: string;
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes published PR bodies with canonical pipeline and worker action evidence.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store as PrSummaryRefreshWorkerStore,
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
      store: options.store,
      logger: options.logger,
      provider: options.provider,
      cwd: options.cwd,
    }),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshWorkerPolicyOptions): Promise<void> {
  const provider = options.provider ?? new GitHubMergeGateProvider();
  if (!provider.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] review provider cannot read/write bodies', {
      module: 'pr-summary-refresh-worker',
      provider: provider.name,
    });
    return;
  }
  const bodyProvider = provider as MergeGateProvider & Required<Pick<MergeGateProvider, 'getReviewBody' | 'updateReviewBody'>>;

  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    const mergeTasks = tasks.filter((task) => task.config.isMergeNode);
    for (const mergeTask of mergeTasks) {
      const targets = reviewTargetsForMergeTask(mergeTask);
      if (targets.length === 0) continue;

      const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
      for (const target of targets) {
        await refreshOnePrSummary({ ...options, provider: bodyProvider, workflow, tasks, mergeTask, target, cwd });
      }
    }
  }
}

async function refreshOnePrSummary(options: PrSummaryRefreshWorkerPolicyOptions & {
  provider: MergeGateProvider & Required<Pick<MergeGateProvider, 'getReviewBody' | 'updateReviewBody'>>;
  workflow: PrSummaryRefreshWorkflow;
  tasks: TaskState[];
  mergeTask: TaskState;
  target: ReviewTarget;
  cwd: string;
}): Promise<void> {
  if (isInvokerRepoUrl(options.workflow.repoUrl)) {
    recordPrSummaryRefreshAction(options, 'skipped', 'PR summary refresh skipped for Invoker review-stack PR', {
      reason: 'invoker-review-stack',
    });
    return;
  }

  const body = buildCanonicalPrBody({
    title: options.workflow.name ?? options.workflow.id,
    workflowSummary: options.workflow.description ?? options.workflow.name ?? options.workflow.id,
    structuredContext: buildPrAuthoringContextFromStoredState(options.workflow, options.tasks, options.store),
  });

  try {
    const currentBody = await options.provider.getReviewBody({
      identifier: options.target.identifier,
      cwd: options.cwd,
    });
    if (normalizePrBody(currentBody) === normalizePrBody(body)) {
      recordPrSummaryRefreshAction(options, 'skipped', 'PR summary already current', {
        reason: 'pr-body-current',
      });
      return;
    }

    await options.provider.updateReviewBody({
      identifier: options.target.identifier,
      cwd: options.cwd,
      body,
    });
    recordPrSummaryRefreshAction(options, 'completed', 'Updated PR summary body');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPrSummaryRefreshAction(options, 'failed', 'Failed to refresh PR summary body', {
      reason: 'provider-error',
      error: message,
    });
    options.logger.warn?.('[worker:pr-summary-refresh] failed to refresh PR body', {
      module: 'pr-summary-refresh-worker',
      workflowId: options.workflow.id,
      taskId: options.mergeTask.id,
      reviewId: options.target.identifier,
      err,
    });
  }
}

function buildPrAuthoringContextFromStoredState(
  workflow: PrSummaryRefreshWorkflow,
  tasks: readonly TaskState[],
  store: PrSummaryRefreshWorkerStore,
): PrAuthoringContext {
  const taskEntries: PrAuthoringTaskEntry[] = tasks
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      ...(task.config.command ? { command: task.config.command } : {}),
    }));

  const workerActions = (store.listWorkerActions?.({ workflowId: workflow.id }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(toPrAuthoringWorkerAction);

  return {
    ...(workflow.name ? { workflowName: workflow.name } : {}),
    ...(workflow.description ? { workflowDescription: workflow.description } : {}),
    tasks: taskEntries,
    ...(workerActions.length > 0 ? { workerActions } : {}),
  };
}

function toPrAuthoringWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function reviewTargetsForMergeTask(task: TaskState): ReviewTarget[] {
  const seen = new Set<string>();
  const targets: ReviewTarget[] = [];
  for (const artifact of getCurrentReviewArtifacts(task)) {
    if (!artifact.providerId || seen.has(artifact.providerId)) continue;
    seen.add(artifact.providerId);
    targets.push({
      identifier: artifact.providerId,
      ...(artifact.url ? { url: artifact.url } : {}),
    });
  }
  if (targets.length === 0 && task.execution.reviewId) {
    targets.push({
      identifier: task.execution.reviewId,
      ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
    });
  }
  return targets;
}

function normalizePrBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions & {
    workflow: PrSummaryRefreshWorkflow;
    mergeTask: TaskState;
    target: ReviewTarget;
  },
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
): void {
  const externalKey = `${options.workflow.id}:${options.mergeTask.id}:${options.target.identifier}`;
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: options.workflow.id,
    taskId: options.mergeTask.id,
    subjectType: 'pull_request',
    subjectId: options.target.identifier,
    externalKey,
    status,
    summary,
    incrementAttempt: true,
    payload: {
      reviewId: options.target.identifier,
      ...(options.target.url ? { reviewUrl: options.target.url } : {}),
      ...payload,
    },
  });

  options.store.logEvent?.(options.mergeTask.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status,
    summary,
    workflowId: options.workflow.id,
    taskId: options.mergeTask.id,
    reviewId: options.target.identifier,
    ...(options.target.url ? { reviewUrl: options.target.url } : {}),
    ...(payload.reason ? { reason: payload.reason } : {}),
    ...(action?.id ? { actionId: action.id } : {}),
  });
}

import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { buildCanonicalPrBody, type PrAuthoringContext, type PrAuthoringTaskEntry } from '../pr-authoring.js';
import type { ReviewProviderRegistry } from '../review-provider-registry.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import { getCurrentReviewArtifacts } from '../task-runner-review-gate.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type WorkflowSummaryRecord = {
  id: string;
  name?: string;
  description?: string;
};

type ReviewArtifact = ReturnType<typeof getCurrentReviewArtifacts>[number];

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<WorkflowSummaryRecord>;
  loadWorkflow?(workflowId: string): WorkflowSummaryRecord | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  reviewProviderRegistry?: ReviewProviderRegistry;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review-gate PR bodies with the canonical pipeline summary and worker actions.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        reviewProviderRegistry: deps.reviewProviderRegistry,
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
    for (const workflow of options.store.listWorkflows()) {
      const workflowRecord = options.store.loadWorkflow?.(workflow.id) ?? workflow;
      const tasks = options.store.loadTasks(workflow.id);
      const mergeTasks = tasks.filter(isRefreshableMergeTask);
      if (mergeTasks.length === 0) continue;

      const structuredContext = buildPrSummaryContext(options.store, workflowRecord, tasks);
      const body = buildCanonicalPrBody({
        title: workflowRecord.name ?? workflowRecord.id,
        workflowSummary: workflowRecord.description ?? workflowRecord.name ?? workflowRecord.id,
        structuredContext,
      });

      for (const task of mergeTasks) {
        for (const artifact of getRefreshableArtifacts(task)) {
          await refreshArtifactSummary(options, workflowRecord, task, artifact, body, structuredContext.workerActions?.length ?? 0);
        }
      }
    }
  };
}

function isRefreshableMergeTask(task: TaskState): boolean {
  return Boolean(task.config.isMergeNode)
    && (task.status === 'review_ready' || task.status === 'awaiting_approval')
    && getRefreshableArtifacts(task).length > 0;
}

function getRefreshableArtifacts(task: TaskState): ReviewArtifact[] {
  return getCurrentReviewArtifacts(task).filter((artifact) =>
    artifact.required
    && !!artifact.providerId
    && artifact.status !== 'closed'
    && artifact.status !== 'approved'
    && artifact.status !== 'merged',
  );
}

function buildPrSummaryContext(
  store: PrSummaryRefreshWorkerStore,
  workflow: WorkflowSummaryRecord,
  tasks: readonly TaskState[],
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
    .map((action) => ({
      id: action.id,
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      subjectType: action.subjectType,
      subjectId: action.subjectId,
      ...(action.taskId ? { taskId: action.taskId } : {}),
      ...(action.summary ? { summary: action.summary } : {}),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
    }));

  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks: taskEntries,
    workerActions,
  };
}

async function refreshArtifactSummary(
  options: PrSummaryRefreshWorkerPolicyOptions,
  workflow: WorkflowSummaryRecord,
  task: TaskState,
  artifact: ReviewArtifact,
  body: string,
  actionCount: number,
): Promise<void> {
  const providerName = artifact.provider ?? 'github';
  const provider = options.reviewProviderRegistry?.get(providerName);
  const reviewId = artifact.providerId;
  const externalKey = summaryRefreshExternalKey(workflow.id, task.id, providerName, reviewId);
  const bodyHash = sha256(body);
  const payload = {
    provider: providerName,
    reviewId,
    reviewUrl: artifact.url ?? null,
    bodyHash,
    workerActionCount: actionCount,
  };

  if (!reviewId || !provider?.getReviewBody || !provider.updateReviewBody) {
    recordSummaryRefreshAction(options, workflow, task, artifact, externalKey, 'failed', 'Cannot refresh PR summary; provider body update is unavailable', {
      ...payload,
      reason: 'provider-update-unavailable',
    });
    return;
  }

  const cwd = task.execution.workspacePath ?? process.cwd();
  try {
    const current = await provider.getReviewBody({ identifier: reviewId, cwd });
    if (normalizeBody(current) === normalizeBody(body)) {
      recordSummaryRefreshAction(options, workflow, task, artifact, externalKey, 'skipped', 'PR summary already current', {
        ...payload,
        reason: 'content-unchanged',
      });
      return;
    }

    await provider.updateReviewBody({ identifier: reviewId, cwd, body });
    recordSummaryRefreshAction(options, workflow, task, artifact, externalKey, 'completed', 'Updated PR summary with pipeline actions', payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR summary`, {
      module: 'pr-summary-refresh-worker',
      workflowId: workflow.id,
      taskId: task.id,
      reviewId,
      err,
    });
    recordSummaryRefreshAction(options, workflow, task, artifact, externalKey, 'failed', `Failed to refresh PR summary: ${message}`, {
      ...payload,
      reason: 'provider-error',
      error: message,
    });
  }
}

function recordSummaryRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  workflow: WorkflowSummaryRecord,
  task: TaskState,
  artifact: ReviewArtifact,
  externalKey: string,
  status: 'completed' | 'failed' | 'skipped',
  summary: string,
  payload: Record<string, unknown>,
): void {
  recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey,
    subjectType: 'review',
    subjectId: artifact.providerId ?? artifact.id,
    workflowId: workflow.id,
    taskId: task.id,
    status,
    summary,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    incrementAttempt: status === 'completed' || status === 'failed',
    payload,
  });
}

function summaryRefreshExternalKey(
  workflowId: string,
  taskId: string,
  providerName: string,
  reviewId: string | undefined,
): string {
  return [workflowId, taskId, providerName, reviewId ?? 'no-review-id'].join(':');
}

function normalizeBody(body: string): string {
  return body.replace(/\s+$/g, '');
}

function sha256(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

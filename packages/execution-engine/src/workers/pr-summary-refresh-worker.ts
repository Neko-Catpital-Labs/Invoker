import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  WorkerActionListFilters,
  Workflow,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import { buildCanonicalPrBody, type PrAuthoringContext, type PrAuthoringWorkerActionEntry } from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type ReviewTarget = {
  identifier: string;
  url?: string;
};

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<Pick<Workflow, 'id'> & Partial<Workflow>>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  cwd?: string;
}

export interface PrSummaryRefreshTickOptions {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  cwd?: string;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        mergeGateProvider: deps.mergeGateProvider,
      }),
  });
  return registry;
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
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
    onTick: options.onTick ?? createPrSummaryRefreshTick(options),
  });
}

export async function refreshPrSummaries(options: PrSummaryRefreshTickOptions): Promise<void> {
  const provider = options.mergeGateProvider;
  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] merge-gate provider cannot read/update bodies', {
      module: 'pr-summary-refresh-worker',
    });
    return;
  }

  for (const workflowRef of options.store.listWorkflows()) {
    const workflow = options.store.loadWorkflow?.(workflowRef.id) ?? workflowRef;
    const tasks = options.store.loadTasks(workflowRef.id);
    const mergeTasks = tasks.filter((task) => task.config.isMergeNode);
    for (const mergeTask of mergeTasks) {
      const targets = collectReviewTargets(mergeTask);
      for (const target of targets) {
        await refreshReviewBodyForMergeTask(options, provider, workflow, tasks, mergeTask, target);
      }
    }
  }
}

async function refreshReviewBodyForMergeTask(
  options: PrSummaryRefreshTickOptions,
  provider: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>,
  workflow: Pick<Workflow, 'id'> & Partial<Workflow>,
  tasks: readonly TaskState[],
  mergeTask: TaskState,
  target: ReviewTarget,
): Promise<void> {
  const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
  const externalKey = `${mergeTask.id}:${target.identifier}`;
  try {
    const body = buildCanonicalPrBody({
      title: workflow.name ?? mergeTask.description ?? workflow.id,
      workflowSummary: workflow.description ?? workflow.name ?? workflow.id,
      structuredContext: buildPrSummaryContext(options.store, workflow, tasks),
    });
    const bodyHash = sha256(body);
    const currentBody = await provider.getReviewBody!({ identifier: target.identifier, cwd });
    if (currentBody.trimEnd() === body.trimEnd()) {
      recordPrSummaryAction(options.store, {
        externalKey,
        workflowId: workflow.id,
        taskId: mergeTask.id,
        reviewId: target.identifier,
        reviewUrl: target.url,
        status: 'skipped',
        summary: 'PR summary already current',
        reason: 'unchanged',
        bodyHash,
      });
      return;
    }

    recordPrSummaryAction(options.store, {
      externalKey,
      workflowId: workflow.id,
      taskId: mergeTask.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'running',
      summary: 'Refreshing PR summary',
      bodyHash,
      incrementAttempt: true,
    });
    await provider.updateReviewBody!({ identifier: target.identifier, cwd, body });
    const saved = recordPrSummaryAction(options.store, {
      externalKey,
      workflowId: workflow.id,
      taskId: mergeTask.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'completed',
      summary: 'PR summary refreshed',
      bodyHash,
    });
    logWorkerActionEvent(options.store, mergeTask.id, saved, {
      reviewId: target.identifier,
      reviewUrl: target.url,
      message: 'PR summary refreshed',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const saved = recordPrSummaryAction(options.store, {
      externalKey,
      workflowId: workflow.id,
      taskId: mergeTask.id,
      reviewId: target.identifier,
      reviewUrl: target.url,
      status: 'failed',
      summary: 'PR summary refresh failed',
      reason: message,
    });
    logWorkerActionEvent(options.store, mergeTask.id, saved, {
      reviewId: target.identifier,
      reviewUrl: target.url,
      message: 'PR summary refresh failed',
      error: message,
    });
    options.logger.warn('[worker:pr-summary-refresh] refresh failed', {
      module: 'pr-summary-refresh-worker',
      workflowId: workflow.id,
      taskId: mergeTask.id,
      reviewId: target.identifier,
      err,
    });
  }
}

function buildPrSummaryContext(
  store: PrSummaryRefreshWorkerStore,
  workflow: Pick<Workflow, 'id'> & Partial<Workflow>,
  tasks: readonly TaskState[],
): PrAuthoringContext {
  const taskEntries = tasks
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed'
        ? 'completed' as const
        : task.status === 'failed'
          ? 'failed' as const
          : 'skipped' as const,
      ...(task.config.command ? { command: task.config.command } : {}),
    }));

  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks: taskEntries,
    workerActions: listPrSummaryWorkerActions(store, workflow.id),
  };
}

function listPrSummaryWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  return (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(toPrAuthoringWorkerAction);
}

function toPrAuthoringWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = workerActionReason(action);
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    timestamp: action.completedAt ?? action.updatedAt ?? action.createdAt,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
  };
}

function workerActionReason(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

function collectReviewTargets(task: TaskState): ReviewTarget[] {
  const targets = new Map<string, ReviewTarget>();
  if (task.execution.reviewId) {
    targets.set(task.execution.reviewId, {
      identifier: task.execution.reviewId,
      ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
    });
  }
  for (const artifact of task.execution.reviewGate?.artifacts ?? []) {
    if (!artifact.providerId) continue;
    targets.set(artifact.providerId, {
      identifier: artifact.providerId,
      ...(artifact.url ? { url: artifact.url } : {}),
    });
  }
  return [...targets.values()];
}

function recordPrSummaryAction(
  store: PrSummaryRefreshWorkerStore,
  args: {
    externalKey: string;
    workflowId: string;
    taskId: string;
    reviewId: string;
    reviewUrl?: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    bodyHash?: string;
    incrementAttempt?: boolean;
  },
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: args.externalKey,
    workflowId: args.workflowId,
    taskId: args.taskId,
    subjectType: 'pull_request',
    subjectId: args.reviewId,
    status: args.status,
    summary: args.summary,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.incrementAttempt !== undefined ? { incrementAttempt: args.incrementAttempt } : {}),
    payload: {
      reviewId: args.reviewId,
      ...(args.reviewUrl ? { reviewUrl: args.reviewUrl } : {}),
      ...(args.bodyHash ? { bodyHash: args.bodyHash } : {}),
    },
  });
}

function logWorkerActionEvent(
  store: PrSummaryRefreshWorkerStore,
  taskId: string,
  action: WorkerActionRecord | undefined,
  detail: Record<string, unknown>,
): void {
  if (!action) return;
  store.logEvent?.(taskId, 'task.worker_action', {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    actionId: action.id,
    summary: action.summary,
    ...detail,
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

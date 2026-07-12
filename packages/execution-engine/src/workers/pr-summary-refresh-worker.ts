import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';
const DEFAULT_MAX_WORKER_ACTIONS = 50;

export interface PrSummaryRefreshWorkflowRecord {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflowRecord>;
  loadWorkflow?(workflowId: string): PrSummaryRefreshWorkflowRecord | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: {
    workflowId?: string;
    taskId?: string;
    workerKind?: string;
    status?: string;
    decision?: 'act' | 'skip';
    limit?: number;
    offset?: number;
  }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
}

export interface PrSummaryRefreshWorkerConfig {
  provider?: Pick<MergeGateProvider, 'getReviewBody' | 'updateReviewBody'>;
  cwd?: string;
  intervalMs?: number;
  maxWorkerActions?: number;
}

export interface PrSummaryRefreshWorkerPolicyOptions extends PrSummaryRefreshWorkerConfig {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
  prSummaryRefresh?: Omit<PrSummaryRefreshWorkerPolicyOptions, 'logger'>;
}

interface ReviewTarget {
  providerId: string;
  reviewUrl?: string;
}

interface PrBodyProvider {
  getReviewBody(opts: { identifier: string; cwd: string }): Promise<string>;
  updateReviewBody(opts: { identifier: string; cwd: string; body: string }): Promise<void>;
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes published PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          provider: deps.prSummaryRefresh?.provider ?? deps.mergeGateProvider,
          cwd: deps.prSummaryRefresh?.cwd,
          intervalMs: deps.prSummaryRefresh?.intervalMs,
          maxWorkerActions: deps.prSummaryRefresh?.maxWorkerActions,
        },
      }),
  });
  return registry;
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? options.prSummaryRefresh?.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.prSummaryRefresh
        ? createPrSummaryRefreshTick({
          ...options.prSummaryRefresh,
          logger: options.logger,
        })
        : (() => {})
    ),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async (ctx) => {
    const provider = options.provider;
    if (!provider?.getReviewBody || !provider.updateReviewBody) {
      options.logger.debug?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] merge-gate body update provider unavailable`, {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }
    const bodyProvider: PrBodyProvider = {
      getReviewBody: provider.getReviewBody.bind(provider),
      updateReviewBody: provider.updateReviewBody.bind(provider),
    };

    for (const listedWorkflow of options.store.listWorkflows()) {
      ctx.signal.throwIfAborted();
      const workflow = options.store.loadWorkflow?.(listedWorkflow.id) ?? listedWorkflow;
      const tasks = options.store.loadTasks(workflow.id);
      const mergeTasks = tasks.filter(isRefreshableMergeTask);
      if (mergeTasks.length === 0) continue;

      const workerActions = collectWorkflowWorkerActions(options.store, workflow.id, options.maxWorkerActions);
      const body = buildPrSummaryRefreshBody({
        workflow,
        tasks,
        workerActions,
      });

      for (const mergeTask of mergeTasks) {
        ctx.signal.throwIfAborted();
        const targets = currentReviewTargets(mergeTask);
        for (const target of targets) {
          ctx.signal.throwIfAborted();
          await refreshOneReview({
            options,
            provider: bodyProvider,
            workflowId: workflow.id,
            mergeTask,
            target,
            body,
          });
        }
      }
    }
  };
}

export function buildPrSummaryRefreshBody(args: {
  workflow: PrSummaryRefreshWorkflowRecord;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
}): string {
  const workflowSummary = args.workflow.description?.trim()
    || args.workflow.name?.trim()
    || args.workflow.id;
  const structuredContext: PrAuthoringContext = {
    tasks: args.tasks
      .filter((task) => !task.config.isMergeNode)
      .map((task) => ({
        taskId: task.id,
        description: task.description,
        status: prAuthoringTaskStatus(task),
        ...(task.config.command ? { command: task.config.command } : {}),
      })),
    workerActions: args.workerActions.map(toPrAuthoringWorkerAction),
  };
  if (args.workflow.name) {
    structuredContext.workflowName = args.workflow.name;
  }
  if (args.workflow.description) {
    structuredContext.workflowDescription = args.workflow.description;
  }

  return buildCanonicalPrBody({
    title: args.workflow.name ?? args.workflow.id,
    workflowSummary,
    structuredContext,
  });
}

async function refreshOneReview(args: {
  options: PrSummaryRefreshWorkerPolicyOptions;
  provider: PrBodyProvider;
  workflowId: string;
  mergeTask: TaskState;
  target: ReviewTarget;
  body: string;
}): Promise<void> {
  const { options, provider, workflowId, mergeTask, target, body } = args;
  const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
  const externalKey = prSummaryRefreshExternalKey(mergeTask.id, target.providerId);

  try {
    const currentBody = await provider.getReviewBody({
      identifier: target.providerId,
      cwd,
    });
    if (normalizePrBody(currentBody) === normalizePrBody(body)) {
      recordPrSummaryRefreshAction(options, {
        externalKey,
        workflowId,
        mergeTaskId: mergeTask.id,
        target,
        status: 'skipped',
        summary: 'PR body already has the current pipeline summary',
        reason: 'up-to-date',
        bodyChanged: false,
      });
      return;
    }

    await provider.updateReviewBody({
      identifier: target.providerId,
      cwd,
      body,
    });
    recordPrSummaryRefreshAction(options, {
      externalKey,
      workflowId,
      mergeTaskId: mergeTask.id,
      target,
      status: 'completed',
      summary: 'Updated PR body with pipeline summary',
      bodyChanged: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR body`, {
      module: 'pr-summary-refresh-worker',
      workflowId,
      taskId: mergeTask.id,
      reviewId: target.providerId,
      err,
    });
    recordPrSummaryRefreshAction(options, {
      externalKey,
      workflowId,
      mergeTaskId: mergeTask.id,
      target,
      status: 'failed',
      summary: `Failed to refresh PR body: ${message}`,
      reason: 'provider-error',
      bodyChanged: false,
      payload: { error: message },
    });
  }
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  fields: {
    externalKey: string;
    workflowId: string;
    mergeTaskId: string;
    target: ReviewTarget;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    bodyChanged: boolean;
    payload?: Record<string, unknown>;
  },
): void {
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: fields.externalKey,
    subjectType: 'review',
    subjectId: fields.target.providerId,
    workflowId: fields.workflowId,
    taskId: fields.mergeTaskId,
    status: fields.status,
    summary: fields.summary,
    reason: fields.reason,
    incrementAttempt: fields.status === 'completed' || fields.status === 'failed',
    payload: {
      reviewId: fields.target.providerId,
      reviewUrl: fields.target.reviewUrl ?? null,
      bodyChanged: fields.bodyChanged,
      ...fields.payload,
    },
  });

  options.store.logEvent?.(fields.mergeTaskId, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: fields.status,
    summary: fields.summary,
    ...(fields.reason ? { reason: fields.reason } : {}),
    workflowId: fields.workflowId,
    reviewId: fields.target.providerId,
    reviewUrl: fields.target.reviewUrl ?? null,
    bodyChanged: fields.bodyChanged,
    ...(action ? { actionId: action.id } : {}),
  });
}

function collectWorkflowWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
  maxWorkerActions = DEFAULT_MAX_WORKER_ACTIONS,
): WorkerActionRecord[] {
  const limit = Math.max(1, maxWorkerActions * 2);
  return (store.listWorkerActions?.({ workflowId, limit }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .slice(0, maxWorkerActions);
}

function toPrAuthoringWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = reasonFromPayload(action.payload);
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
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

function reasonFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function prAuthoringTaskStatus(task: TaskState): 'completed' | 'failed' | 'skipped' {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  return 'skipped';
}

function isRefreshableMergeTask(task: TaskState): boolean {
  if (!task.config.isMergeNode) return false;
  return task.status === 'review_ready'
    || task.status === 'awaiting_approval'
    || task.status === 'completed';
}

function currentReviewTargets(task: TaskState): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  const gate = task.execution.reviewGate;
  if (gate) {
    for (const artifact of gate.artifacts) {
      if (artifact.generation !== gate.activeGeneration) continue;
      if (artifact.status === 'discarded' || artifact.discardedAt) continue;
      if (!artifact.providerId) continue;
      targets.push({
        providerId: artifact.providerId,
        ...(artifact.url ? { reviewUrl: artifact.url } : {}),
      });
    }
  } else if (task.execution.reviewId) {
    targets.push({
      providerId: task.execution.reviewId,
      ...(task.execution.reviewUrl ? { reviewUrl: task.execution.reviewUrl } : {}),
    });
  }

  const seen = new Set<string>();
  return targets.filter((target) => {
    if (seen.has(target.providerId)) return false;
    seen.add(target.providerId);
    return true;
  });
}

function prSummaryRefreshExternalKey(taskId: string, providerId: string): string {
  return `${PR_SUMMARY_REFRESH_WORKER_KIND}:${taskId}:${providerId}`;
}

function normalizePrBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

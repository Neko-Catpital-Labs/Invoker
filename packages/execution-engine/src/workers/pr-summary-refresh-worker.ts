import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerRegistry } from '../worker-registry.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 2 * 60_000;

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<Pick<Workflow, 'id' | 'name' | 'description' | 'repoUrl' | 'baseBranch' | 'featureBranch'>>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: {
    workflowId?: string;
    taskId?: string;
    workerKind?: string;
    status?: WorkerActionStatus | string;
    decision?: 'act' | 'skip';
    limit?: number;
    offset?: number;
  }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  reviewProvider?: MergeGateProvider;
  /** Fallback working directory for provider calls when the merge task has no persisted workspace. */
  cwd?: string;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

type ReviewTarget = {
  workflowId: string;
  mergeTask: TaskState;
  identifier: string;
  url?: string;
  cwd: string;
};

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
      reviewProvider: options.reviewProvider,
      cwd: options.cwd,
    }),
  });
}

export function createPrSummaryRefreshTick(options: {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  reviewProvider?: MergeGateProvider;
  cwd?: string;
}): WorkerTick {
  return async (ctx) => {
    const reviewProvider = options.reviewProvider;
    if (!reviewProvider?.getReviewBody || !reviewProvider.updateReviewBody) {
      options.logger.debug?.('[worker:pr-summary-refresh] review provider body update dependency unavailable', {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const workflowRow of options.store.listWorkflows()) {
      ctx.signal.throwIfAborted();
      const workflow = options.store.loadWorkflow?.(workflowRow.id) ?? workflowRow;
      const tasks = options.store.loadTasks(workflowRow.id);
      for (const target of findReviewTargets({
        workflowId: workflowRow.id,
        tasks,
        fallbackCwd: options.cwd,
      })) {
        ctx.signal.throwIfAborted();
        await refreshTarget({
          logger: options.logger,
          store: options.store,
          reviewProvider,
          workflow,
          tasks,
          target,
        });
      }
    }
  };
}

function findReviewTargets(args: {
  workflowId: string;
  tasks: readonly TaskState[];
  fallbackCwd?: string;
}): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  for (const task of args.tasks) {
    if (!task.config.isMergeNode) continue;
    if (task.config.workflowId !== args.workflowId) continue;
    const cwd = task.execution.workspacePath ?? args.fallbackCwd;
    if (!cwd) continue;

    const gate = task.execution.reviewGate;
    if (gate) {
      let foundActiveArtifact = false;
      for (const artifact of gate.artifacts) {
        if (!artifact.providerId) continue;
        if (artifact.generation !== gate.activeGeneration) continue;
        if (artifact.status === 'discarded' || artifact.discardedAt) continue;
        foundActiveArtifact = true;
        targets.push({
          workflowId: args.workflowId,
          mergeTask: task,
          identifier: artifact.providerId,
          url: artifact.url,
          cwd,
        });
      }
      if (foundActiveArtifact) continue;
    }

    if (task.execution.reviewId) {
      targets.push({
        workflowId: args.workflowId,
        mergeTask: task,
        identifier: task.execution.reviewId,
        url: task.execution.reviewUrl,
        cwd,
      });
    }
  }
  return targets;
}

async function refreshTarget(args: {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  reviewProvider: MergeGateProvider;
  workflow: Pick<Workflow, 'id' | 'name' | 'description' | 'repoUrl' | 'baseBranch' | 'featureBranch'>;
  tasks: readonly TaskState[];
  target: ReviewTarget;
}): Promise<void> {
  const externalKey = `${args.target.workflowId}:${args.target.identifier}:pipeline`;
  const common = {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'refresh-pr-summary',
    externalKey,
    workflowId: args.target.workflowId,
    taskId: args.target.mergeTask.id,
    subjectType: 'review',
    subjectId: args.target.identifier,
  } as const;

  try {
    recordAction(args.store, {
      ...common,
      status: 'running',
      summary: `Checking PR ${args.target.identifier} summary`,
      incrementAttempt: true,
    });

    const body = buildCanonicalPrBody({
      title: args.workflow.name,
      workflowSummary: buildWorkflowSummary(args.workflow, args.tasks),
      structuredContext: buildStructuredContext(args.workflow, args.tasks, args.store),
    });
    const liveBody = await args.reviewProvider.getReviewBody!({
      identifier: args.target.identifier,
      cwd: args.target.cwd,
    });

    if (sameBody(liveBody, body)) {
      recordAction(args.store, {
        ...common,
        status: 'skipped',
        summary: `PR ${args.target.identifier} summary already current`,
        reason: 'unchanged',
      });
      return;
    }

    await args.reviewProvider.updateReviewBody!({
      identifier: args.target.identifier,
      cwd: args.target.cwd,
      body,
    });
    recordAction(args.store, {
      ...common,
      status: 'completed',
      summary: `Updated PR ${args.target.identifier} pipeline summary`,
      payload: {
        reviewUrl: args.target.url,
        bodyLength: body.length,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    args.logger.warn(`[worker:pr-summary-refresh] failed to refresh ${args.target.identifier}: ${message}`, {
      module: 'pr-summary-refresh-worker',
      workflowId: args.target.workflowId,
      taskId: args.target.mergeTask.id,
      reviewId: args.target.identifier,
    });
    recordAction(args.store, {
      ...common,
      status: 'failed',
      summary: `Failed to refresh PR ${args.target.identifier} pipeline summary`,
      reason: 'provider-error',
      payload: { error: message, reviewUrl: args.target.url },
    });
  }
}

function buildStructuredContext(
  workflow: Pick<Workflow, 'id' | 'name' | 'description'>,
  tasks: readonly TaskState[],
  store: PrSummaryRefreshWorkerStore,
): PrAuthoringContext {
  return {
    workflowName: workflow.name,
    ...(workflow.description ? { workflowDescription: workflow.description } : {}),
    tasks: tasks
      .filter((task) => !task.config.isMergeNode)
      .map(taskToPrEntry),
    workerActions: workerActionsForWorkflow(workflow.id, store),
  };
}

function taskToPrEntry(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function workerActionsForWorkflow(
  workflowId: string,
  store: PrSummaryRefreshWorkerStore,
): PrAuthoringWorkerActionEntry[] {
  const rows = store.listWorkerActions?.({ workflowId }) ?? [];
  return rows
    .filter((row) => row.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((row) => {
      const reason = payloadReason(row.payload);
      return {
        workerKind: row.workerKind,
        actionType: row.actionType,
        status: row.status,
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        ...(row.taskId ? { taskId: row.taskId } : {}),
        ...(row.summary ? { summary: row.summary } : {}),
        ...(reason ? { reason } : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
        ...(row.completedAt ? { completedAt: row.completedAt } : {}),
      };
    });
}

function buildWorkflowSummary(
  workflow: Pick<Workflow, 'name' | 'description'>,
  tasks: readonly TaskState[],
): string {
  const nonMerge = tasks.filter((task) => !task.config.isMergeNode);
  const completed = nonMerge.filter((task) => task.status === 'completed').length;
  const failed = nonMerge.filter((task) => task.status === 'failed').length;
  const closed = nonMerge.filter((task) => task.status === 'closed').length;
  const skipped = nonMerge.length - completed - failed - closed;
  return `${workflow.name} — ${completed} tasks completed, ${failed} failed, ${closed} closed, ${skipped} skipped`;
}

function sameBody(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

function payloadReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.length > 0 ? reason : undefined;
}

function recordAction(
  store: PrSummaryRefreshWorkerStore,
  row: Parameters<typeof recordWorkerDecisionRow>[1],
): void {
  const saved = recordWorkerDecisionRow(store, row);
  if (saved) {
    recordTaskWorkerActionEvent(store, saved);
  } else if (row.taskId) {
    store.logEvent?.(row.taskId, 'task.worker_action', {
      workerKind: row.workerKind,
      actionType: row.actionType,
      status: row.status,
      summary: row.summary,
      ...(row.reason ? { reason: row.reason } : {}),
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      workflowId: row.workflowId,
    });
  }
}

function recordTaskWorkerActionEvent(
  store: PrSummaryRefreshWorkerStore,
  action: WorkerActionRecord | WorkerActionWrite,
): void {
  if (!action.taskId) return;
  const reason = payloadReason(action.payload);
  store.logEvent?.(action.taskId, 'task.worker_action', {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    workflowId: action.workflowId,
    taskId: action.taskId,
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    externalKey: action.externalKey,
    summary: action.summary,
    ...(reason ? { reason } : {}),
  });
}

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

type WorkflowSummary = Pick<Workflow, 'id' | 'name' | 'description'>;

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadTasks(workflowId: string): TaskState[];
  loadWorkflow?(workflowId: string): WorkflowSummary | undefined;
  listWorkerActions(filters?: { workflowId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

type WorkerDecisionStoreSurface = Parameters<typeof recordWorkerDecisionRow>[0];

export type PrSummaryRefreshProvider = Pick<
  MergeGateProvider,
  'name' | 'getReviewBody' | 'updateReviewBody'
>;

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore & WorkerDecisionStoreSurface;
  mergeGateProvider?: PrSummaryRefreshProvider;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore & WorkerDecisionStoreSurface;
  mergeGateProvider: PrSummaryRefreshProvider;
}

interface PrSummaryTarget {
  identifier: string;
  externalKey: string;
  title?: string;
  url?: string;
  provider?: string;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes published PR bodies with Invoker pipeline worker action history.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store as unknown as PrSummaryRefreshWorkerStore & WorkerDecisionStoreSurface,
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
      mergeGateProvider: options.mergeGateProvider ?? new GitHubMergeGateProvider(),
    }),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshTickOptions): Promise<void> {
  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    for (const task of tasks) {
      if (!task.config.isMergeNode) continue;
      await refreshMergeTaskSummary(options, workflow.id, task, tasks);
    }
  }
}

export function buildPrSummaryRefreshBody(args: {
  workflowId: string;
  workflow?: WorkflowSummary;
  mergeTask: TaskState;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
}): string {
  const context = buildPrSummaryAuthoringContext(args);
  return buildCanonicalPrBody({
    title: args.workflow?.name ?? args.mergeTask.description,
    workflowSummary: args.mergeTask.config.summary
      ?? args.workflow?.description
      ?? `${args.workflow?.name ?? args.workflowId} pull request summary.`,
    structuredContext: context,
  });
}

async function refreshMergeTaskSummary(
  options: PrSummaryRefreshTickOptions,
  workflowId: string,
  mergeTask: TaskState,
  tasks: readonly TaskState[],
): Promise<void> {
  const targets = listCurrentReviewTargets(mergeTask, options.mergeGateProvider.name);
  if (targets.length === 0) return;

  const cwd = mergeTask.execution.workspacePath?.trim();
  if (!cwd) {
    for (const target of targets) {
      recordSummaryRefreshAction(options, mergeTask.id, {
        workflowId,
        externalKey: target.externalKey,
        status: 'skipped',
        summary: 'Skipped PR summary refresh because the review workspace is unavailable',
        reason: 'missing-review-workspace',
        payload: targetPayload(target),
      });
    }
    return;
  }

  if (!options.mergeGateProvider.getReviewBody || !options.mergeGateProvider.updateReviewBody) {
    for (const target of targets) {
      recordSummaryRefreshAction(options, mergeTask.id, {
        workflowId,
        externalKey: target.externalKey,
        status: 'skipped',
        summary: 'Skipped PR summary refresh because the provider cannot read and update bodies',
        reason: 'provider-body-update-unavailable',
        payload: targetPayload(target),
      });
    }
    return;
  }

  const workflow = options.store.loadWorkflow?.(workflowId);
  const workerActions = options.store
    .listWorkerActions({ workflowId })
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND);
  const body = buildPrSummaryRefreshBody({
    workflowId,
    workflow,
    mergeTask,
    tasks,
    workerActions,
  });

  for (const target of targets) {
    try {
      const currentBody = await options.mergeGateProvider.getReviewBody({
        identifier: target.identifier,
        cwd,
      });
      if (normalizeBody(currentBody) === normalizeBody(body)) {
        recordSummaryRefreshAction(options, mergeTask.id, {
          workflowId,
          externalKey: target.externalKey,
          status: 'skipped',
          summary: 'PR summary already current',
          reason: 'no-content-change',
          payload: {
            ...targetPayload(target),
            bodyLength: body.length,
          },
        });
        continue;
      }

      recordSummaryRefreshAction(options, mergeTask.id, {
        workflowId,
        externalKey: target.externalKey,
        status: 'running',
        summary: 'Refreshing PR summary body',
        payload: {
          ...targetPayload(target),
          previousBodyLength: currentBody.length,
          nextBodyLength: body.length,
        },
        incrementAttempt: true,
      });
      await options.mergeGateProvider.updateReviewBody({
        identifier: target.identifier,
        cwd,
        body,
      });
      recordSummaryRefreshAction(options, mergeTask.id, {
        workflowId,
        externalKey: target.externalKey,
        status: 'completed',
        summary: 'Refreshed PR summary body',
        payload: {
          ...targetPayload(target),
          bodyLength: body.length,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR summary`, {
        module: 'pr-summary-refresh-worker',
        workflowId,
        taskId: mergeTask.id,
        reviewId: target.identifier,
        err: message,
      });
      recordSummaryRefreshAction(options, mergeTask.id, {
        workflowId,
        externalKey: target.externalKey,
        status: 'failed',
        summary: `Failed to refresh PR summary: ${message}`,
        reason: 'update-failed',
        payload: {
          ...targetPayload(target),
          error: message,
        },
      });
    }
  }
}

function buildPrSummaryAuthoringContext(args: {
  workflowId: string;
  workflow?: WorkflowSummary;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
}): PrAuthoringContext {
  return {
    workflowName: args.workflow?.name,
    workflowDescription: args.workflow?.description,
    tasks: args.tasks
      .filter((task) => !task.config.isMergeNode)
      .map(toPrAuthoringTaskEntry),
    workerActions: args.workerActions.map(toPrAuthoringWorkerActionEntry),
  };
}

function toPrAuthoringTaskEntry(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    command: task.config.command,
  };
}

function toPrAuthoringWorkerActionEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload as Record<string, unknown>
    : {};
  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    taskId: action.taskId,
    summary: action.summary,
    reason,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    completedAt: action.completedAt,
  };
}

function listCurrentReviewTargets(task: TaskState, providerName: string): PrSummaryTarget[] {
  const seen = new Set<string>();
  const targets: PrSummaryTarget[] = [];
  const add = (target: PrSummaryTarget): void => {
    const key = `${target.provider ?? providerName}:${target.identifier}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push(target);
  };

  const gate = task.execution.reviewGate;
  if (gate) {
    for (const artifact of gate.artifacts) {
      if (artifact.discardedAt) continue;
      if (artifact.generation !== gate.activeGeneration) continue;
      if (artifact.provider && artifact.provider !== providerName) continue;
      if (!artifact.providerId) continue;
      add({
        identifier: artifact.providerId,
        externalKey: `${task.id}:${artifact.providerId}`,
        title: artifact.title,
        url: artifact.url,
        provider: artifact.provider,
      });
    }
  }

  if (targets.length === 0 && task.execution.reviewId) {
    add({
      identifier: task.execution.reviewId,
      externalKey: `${task.id}:${task.execution.reviewId}`,
      url: task.execution.reviewUrl,
      provider: providerName,
    });
  }

  return targets;
}

function recordSummaryRefreshAction(
  options: PrSummaryRefreshTickOptions,
  taskId: string,
  row: {
    workflowId: string;
    externalKey: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    payload?: Record<string, unknown>;
    incrementAttempt?: boolean;
  },
): WorkerActionRecord | undefined {
  const decision: WorkerDecisionRow = {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: 'refresh-pr-summary',
    externalKey: row.externalKey,
    workflowId: row.workflowId,
    taskId,
    subjectType: 'pull_request',
    subjectId: row.externalKey,
    status: row.status,
    summary: row.summary,
    reason: row.reason,
    payload: row.payload,
    incrementAttempt: row.incrementAttempt,
  };
  const record = recordWorkerDecisionRow(options.store, decision);
  options.store.logEvent?.(taskId, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: decision.actionType,
    status: row.status,
    summary: row.summary,
    ...(row.reason ? { reason: row.reason } : {}),
    externalKey: row.externalKey,
    ...(record ? { actionId: record.id } : {}),
  });
  return record;
}

function targetPayload(target: PrSummaryTarget): Record<string, unknown> {
  return {
    reviewId: target.identifier,
    ...(target.url ? { reviewUrl: target.url } : {}),
    ...(target.title ? { title: target.title } : {}),
    ...(target.provider ? { provider: target.provider } : {}),
  };
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

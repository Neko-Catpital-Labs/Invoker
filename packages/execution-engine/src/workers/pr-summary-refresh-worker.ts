import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus } from '@invoker/data-store';
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
import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): {
    id: string;
    name: string;
    description?: string;
    repoUrl?: string;
  } | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: {
    workflowId?: string;
    taskId?: string;
    workerKind?: string;
    limit?: number;
  }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  intervalMs?: number;
  cwd?: string;
  provider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
}

export interface PrSummaryRefreshPolicyOptions extends PrSummaryRefreshWorkerConfig {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshPolicyOptions {
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

interface ReviewArtifactTarget {
  artifact: ReviewGateArtifact;
  generation: number;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes PR bodies with the current Invoker pipeline summary and worker actions.',
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
    onTick: options.onTick ?? createPrSummaryRefreshTick(options),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshPolicyOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshPolicyOptions): Promise<void> {
  const provider = options.provider ?? new GitHubMergeGateProvider();
  if (!provider.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] review provider cannot read and update PR bodies', {
      module: 'pr-summary-refresh-worker',
      provider: provider.name,
    });
    return;
  }

  for (const workflow of options.store.listWorkflows()) {
    const tasks = options.store.loadTasks(workflow.id);
    const mergeTasks = tasks.filter((task) => task.config.isMergeNode);
    for (const mergeTask of mergeTasks) {
      const targets = currentReviewTargets(mergeTask);
      for (const target of targets) {
        await refreshOneReviewBody(options, provider, workflow.id, tasks, mergeTask, target);
      }
    }
  }
}

async function refreshOneReviewBody(
  options: PrSummaryRefreshPolicyOptions,
  provider: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>,
  workflowId: string,
  tasks: readonly TaskState[],
  mergeTask: TaskState,
  target: ReviewArtifactTarget,
): Promise<void> {
  const providerId = target.artifact.providerId;
  if (!providerId || !provider.getReviewBody || !provider.updateReviewBody) return;

  const cwd = mergeTask.execution.workspacePath?.trim() || options.cwd || process.cwd();
  const desiredBody = renderPrSummaryBody(options.store, workflowId, tasks, mergeTask);
  const externalKey = [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    mergeTask.id,
    target.generation,
    provider.name,
    providerId,
  ].join(':');
  const payloadBase = {
    provider: provider.name,
    reviewId: providerId,
    reviewUrl: target.artifact.url ?? mergeTask.execution.reviewUrl ?? null,
    generation: target.generation,
    bodyHash: hashText(desiredBody),
  };

  recordPrSummaryRefreshAction(options, {
    externalKey,
    workflowId,
    taskId: mergeTask.id,
    subjectId: providerId,
    status: 'running',
    summary: 'Checking PR body pipeline summary',
    payload: payloadBase,
    incrementAttempt: true,
  });

  try {
    const currentBody = await provider.getReviewBody({ identifier: providerId, cwd });
    if (normalizeBodyForCompare(currentBody) === normalizeBodyForCompare(desiredBody)) {
      const record = recordPrSummaryRefreshAction(options, {
        externalKey,
        workflowId,
        taskId: mergeTask.id,
        subjectId: providerId,
        status: 'skipped',
        summary: 'PR body pipeline summary already current',
        reason: 'body-current',
        payload: payloadBase,
      });
      logTaskWorkerAction(options.store, mergeTask.id, record, {
        ...payloadBase,
        status: 'skipped',
        reason: 'body-current',
        message: 'PR body pipeline summary already current',
      });
      return;
    }

    await provider.updateReviewBody({ identifier: providerId, cwd, body: desiredBody });
    const record = recordPrSummaryRefreshAction(options, {
      externalKey,
      workflowId,
      taskId: mergeTask.id,
      subjectId: providerId,
      status: 'completed',
      summary: 'Updated PR body pipeline summary',
      payload: payloadBase,
    });
    logTaskWorkerAction(options.store, mergeTask.id, record, {
      ...payloadBase,
      status: 'completed',
      message: 'Updated PR body pipeline summary',
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const record = recordPrSummaryRefreshAction(options, {
      externalKey,
      workflowId,
      taskId: mergeTask.id,
      subjectId: providerId,
      status: 'failed',
      summary: `Failed to refresh PR body pipeline summary: ${message}`,
      reason: 'provider-error',
      payload: {
        ...payloadBase,
        error: message,
      },
    });
    logTaskWorkerAction(options.store, mergeTask.id, record, {
      ...payloadBase,
      status: 'failed',
      reason: 'provider-error',
      error: message,
      message: 'Failed to refresh PR body pipeline summary',
    });
    options.logger.warn('[worker:pr-summary-refresh] failed to refresh PR body', {
      module: 'pr-summary-refresh-worker',
      taskId: mergeTask.id,
      reviewId: providerId,
      err,
    });
  }
}

function renderPrSummaryBody(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
  tasks: readonly TaskState[],
  mergeTask: TaskState,
): string {
  const workflow = store.loadWorkflow?.(workflowId);
  const structuredContext: PrAuthoringContext = {
    ...(workflow?.name ? { workflowName: workflow.name } : {}),
    ...(workflow?.description ? { workflowDescription: workflow.description } : {}),
    tasks: tasks
      .filter((task) => !task.config.isMergeNode)
      .map((task) => ({
        taskId: task.id,
        description: task.description,
        status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
        ...(task.config.command ? { command: task.config.command } : {}),
      })),
    workerActions: listPrBodyWorkerActions(store, workflowId),
  };

  return buildCanonicalPrBody({
    title: workflow?.name ?? mergeTask.description,
    workflowSummary: mergeTask.config.summary ?? workflow?.description ?? mergeTask.description,
    structuredContext,
  });
}

function listPrBodyWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  const actions = store.listWorkerActions?.({ workflowId }) ?? [];
  return actions
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((action) => ({
      id: action.id,
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      ...(action.taskId ? { taskId: action.taskId } : {}),
      ...(action.workflowId ? { workflowId: action.workflowId } : {}),
      ...(action.summary ? { summary: action.summary } : {}),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt ? { completedAt: action.completedAt } : {}),
    }));
}

function currentReviewTargets(task: TaskState): ReviewArtifactTarget[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts
      .filter((artifact) =>
        artifact.generation === gate.activeGeneration
        && artifact.status !== 'discarded'
        && !artifact.discardedAt
        && !!artifact.providerId,
      )
      .map((artifact) => ({ artifact, generation: gate.activeGeneration }));
  }

  if (task.execution.reviewId) {
    const artifact: ReviewGateArtifact = {
      id: task.execution.reviewId,
      providerId: task.execution.reviewId,
      required: true,
      status: 'open',
      generation: task.execution.generation ?? 0,
      ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
    };
    return [{
      generation: task.execution.generation ?? 0,
      artifact,
    }];
  }

  return [];
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshPolicyOptions,
  row: {
    externalKey: string;
    workflowId: string;
    taskId: string;
    subjectId: string;
    status: WorkerActionStatus;
    summary: string;
    reason?: string;
    payload: Record<string, unknown>;
    incrementAttempt?: boolean;
  },
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: row.externalKey,
    subjectType: 'review',
    subjectId: row.subjectId,
    workflowId: row.workflowId,
    taskId: row.taskId,
    status: row.status,
    summary: row.summary,
    reason: row.reason,
    payload: row.payload,
    incrementAttempt: row.incrementAttempt,
  });
}

function logTaskWorkerAction(
  store: PrSummaryRefreshWorkerStore,
  taskId: string,
  record: WorkerActionRecord | undefined,
  payload: Record<string, unknown>,
): void {
  store.logEvent?.(taskId, 'task.worker_action', {
    worker: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    actionId: record?.id,
    ...payload,
  });
}

function normalizeBodyForCompare(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

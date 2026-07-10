import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  isInvokerRepoUrl,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import { recordWorkerDecisionRow } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type PrSummaryRefreshWorkflow = Pick<Workflow, 'id'> & Partial<Pick<
  Workflow,
  'name' | 'description' | 'repoUrl' | 'baseBranch' | 'featureBranch'
>>;

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflow>;
  loadWorkflow?(workflowId: string): PrSummaryRefreshWorkflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workflowId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  provider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  prSummaryRefresh?: Omit<PrSummaryRefreshPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshCandidate {
  workflowId: string;
  mergeTask: TaskState;
  reviewId: string;
  cwd: string;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes PR Pipeline summary sections from durable worker actions.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          provider: deps.mergeGateProvider,
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
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS,
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

export function listPrSummaryRefreshCandidates(
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkflows' | 'loadTasks'>,
): PrSummaryRefreshCandidate[] {
  const candidates: PrSummaryRefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (!task.config.isMergeNode) continue;
      const workflowId = task.config.workflowId ?? workflow.id;
      const reviewId = task.execution.reviewId?.trim();
      const cwd = task.execution.workspacePath?.trim();
      if (!workflowId || !reviewId || !cwd) continue;
      candidates.push({ workflowId, mergeTask: task, reviewId, cwd });
    }
  }
  return candidates;
}

export function buildPrSummaryRefreshBody(
  store: PrSummaryRefreshWorkerStore,
  candidate: PrSummaryRefreshCandidate,
): string {
  const workflow = store.loadWorkflow?.(candidate.workflowId)
    ?? store.listWorkflows().find((item) => item.id === candidate.workflowId);
  const tasks = store.loadTasks(candidate.workflowId);
  const context = buildPrSummaryRefreshContext(store, candidate.workflowId, tasks, workflow);
  const summary = candidate.mergeTask.config.summary
    ?? workflow?.description
    ?? `Workflow ${candidate.workflowId}`;
  return buildCanonicalPrBody({
    title: workflow?.name ?? candidate.mergeTask.description,
    workflowSummary: summary,
    structuredContext: context,
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshPolicyOptions): WorkerTick {
  return async () => {
    const provider = options.provider;
    if (!provider?.getReviewBody || !provider.updateReviewBody) {
      options.logger.debug?.('[worker:pr-summary-refresh] review body provider unavailable', {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const candidate of listPrSummaryRefreshCandidates(options.store)) {
      const workflow = options.store.loadWorkflow?.(candidate.workflowId)
        ?? options.store.listWorkflows().find((item) => item.id === candidate.workflowId);

      if (isInvokerRepoUrl(workflow?.repoUrl)) {
        recordPrSummaryRefreshAction(options, candidate, 'skipped', 'Skipped review-stack PR body refresh', {
          reason: 'review-stack-pr',
        });
        continue;
      }

      let nextBody: string;
      try {
        nextBody = buildPrSummaryRefreshBody(options.store, candidate);
      } catch (err) {
        recordPrSummaryRefreshAction(options, candidate, 'failed', 'Failed to render PR summary body', {
          reason: 'render-failed',
          error: err instanceof Error ? err.message : String(err),
        });
        continue;
      }

      try {
        const liveBody = await provider.getReviewBody({
          identifier: candidate.reviewId,
          cwd: candidate.cwd,
        });
        if (normalizeBodyForCompare(liveBody) === normalizeBodyForCompare(nextBody)) {
          recordPrSummaryRefreshAction(options, candidate, 'skipped', 'PR Pipeline summary already current', {
            reason: 'body-current',
            bodyHash: sha256(nextBody),
          });
          continue;
        }

        recordPrSummaryRefreshAction(options, candidate, 'running', 'Refreshing PR Pipeline summary', {
          bodyHash: sha256(nextBody),
          provider: provider.name,
          incrementAttempt: true,
        });
        await provider.updateReviewBody({
          identifier: candidate.reviewId,
          cwd: candidate.cwd,
          body: nextBody,
        });
        recordPrSummaryRefreshAction(options, candidate, 'completed', 'Updated PR Pipeline summary', {
          bodyHash: sha256(nextBody),
          provider: provider.name,
        });
      } catch (err) {
        recordPrSummaryRefreshAction(options, candidate, 'failed', 'Failed to update PR Pipeline summary', {
          reason: 'provider-update-failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  };
}

function buildPrSummaryRefreshContext(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
  tasks: readonly TaskState[],
  workflow: Pick<PrSummaryRefreshWorkflow, 'name' | 'description'> | undefined,
): PrAuthoringContext {
  return {
    workflowName: workflow?.name,
    workflowDescription: workflow?.description,
    tasks: tasks
      .filter((task) => !task.config.isMergeNode)
      .map(toPrAuthoringTask),
    workerActions: (store.listWorkerActions?.({ workflowId }) ?? [])
      .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
      .map(toPrAuthoringWorkerAction),
  };
}

function toPrAuthoringTask(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed'
      ? 'completed'
      : task.status === 'failed'
        ? 'failed'
        : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function toPrAuthoringWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = workerActionReason(action);
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    attemptCount: action.attemptCount,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function workerActionReason(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  status: WorkerActionRecord['status'],
  summary: string,
  payload: Record<string, unknown> & { incrementAttempt?: boolean } = {},
): void {
  const { incrementAttempt, ...payloadWithoutControl } = payload;
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: prSummaryRefreshExternalKey(candidate),
    subjectType: 'review',
    subjectId: candidate.reviewId,
    workflowId: candidate.workflowId,
    taskId: candidate.mergeTask.id,
    status,
    summary,
    incrementAttempt: Boolean(incrementAttempt),
    payload: {
      reviewId: candidate.reviewId,
      reviewUrl: candidate.mergeTask.execution.reviewUrl ?? null,
      generation: candidate.mergeTask.execution.generation ?? 0,
      ...payloadWithoutControl,
    },
  });

  options.store.logEvent?.(candidate.mergeTask.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status,
    summary,
    reviewId: candidate.reviewId,
    reviewUrl: candidate.mergeTask.execution.reviewUrl,
    actionId: action?.id,
    ...(typeof payloadWithoutControl.reason === 'string' ? { reason: payloadWithoutControl.reason } : {}),
  });
}

function prSummaryRefreshExternalKey(candidate: PrSummaryRefreshCandidate): string {
  const generation = candidate.mergeTask.execution.generation ?? 0;
  return `${candidate.mergeTask.id}:${candidate.reviewId}:g${generation}`;
}

function normalizeBodyForCompare(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

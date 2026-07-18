import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
} from '@invoker/data-store';
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

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): { id: string; name?: string; description?: string } | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  store: PrSummaryRefreshWorkerStore;
  provider?: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshCandidate {
  workflowId: string;
  mergeTask: TaskState;
  artifact: ReviewGateArtifact;
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
        store: deps.store,
        provider: deps.mergeGateProvider,
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
    const candidates = listPrSummaryRefreshCandidates(options.store);
    if (candidates.length === 0) {
      options.logger.debug?.('[worker:pr-summary-refresh] no merge review tasks found', {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const candidate of candidates) {
      await refreshCandidate(candidate, options);
    }
  };
}

export function listPrSummaryRefreshCandidates(
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkflows' | 'loadTasks'>,
): PrSummaryRefreshCandidate[] {
  const candidates: PrSummaryRefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    const tasks = store.loadTasks(workflow.id);
    for (const mergeTask of tasks) {
      if (!mergeTask.config.isMergeNode) continue;
      for (const artifact of activeReviewArtifacts(mergeTask)) {
        candidates.push({ workflowId: workflow.id, mergeTask, artifact });
      }
    }
  }
  return candidates;
}

function activeReviewArtifacts(task: TaskState): ReviewGateArtifact[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts.filter((artifact) =>
      artifact.generation === gate.activeGeneration
      && artifact.status !== 'discarded'
      && !artifact.discardedAt
      && Boolean(artifact.providerId),
    );
  }

  if (!task.execution.reviewId && !task.execution.reviewUrl) return [];
  return [{
    id: task.execution.reviewId ?? 'review',
    providerId: task.execution.reviewId,
    url: task.execution.reviewUrl,
    provider: task.execution.reviewProviderId,
    required: true,
    status: 'open',
    generation: task.execution.generation ?? 0,
  }];
}

async function refreshCandidate(
  candidate: PrSummaryRefreshCandidate,
  options: PrSummaryRefreshWorkerOptions,
): Promise<void> {
  const reviewId = candidate.artifact.providerId;
  const cwd = candidate.mergeTask.execution.workspacePath;
  const externalKey = prSummaryRefreshExternalKey(candidate);

  if (!reviewId) {
    recordRefreshAction(options, candidate, 'skipped', 'Missing review provider id', {
      reason: 'missing-review-id',
      externalKey,
    });
    return;
  }
  if (!cwd) {
    recordRefreshAction(options, candidate, 'skipped', 'Missing review workspace path', {
      reason: 'missing-workspace-path',
      externalKey,
    });
    return;
  }
  if (!options.provider?.getReviewBody || !options.provider.updateReviewBody) {
    recordRefreshAction(options, candidate, 'skipped', 'Review provider cannot refresh PR bodies', {
      reason: 'provider-unavailable',
      externalKey,
    });
    return;
  }

  try {
    const body = buildPrSummaryBody(candidate, options.store);
    const current = await options.provider.getReviewBody({ identifier: reviewId, cwd });
    const bodyHash = sha256(body);
    if (normalizeBodyForCompare(current) === normalizeBodyForCompare(body)) {
      recordRefreshAction(options, candidate, 'skipped', 'PR body already includes current Invoker pipeline summary', {
        reason: 'body-current',
        externalKey,
        bodyHash,
      });
      return;
    }

    await options.provider.updateReviewBody({ identifier: reviewId, cwd, body });
    recordRefreshAction(options, candidate, 'completed', 'Updated PR body with Invoker pipeline summary', {
      externalKey,
      bodyHash,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.error?.('[worker:pr-summary-refresh] failed to refresh PR body', {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflowId,
      taskId: candidate.mergeTask.id,
      reviewId,
      err,
    });
    recordRefreshAction(options, candidate, 'failed', 'Failed to update PR body with Invoker pipeline summary', {
      reason: 'update-failed',
      error: message,
      externalKey,
    });
  }
}

export function buildPrSummaryBody(
  candidate: PrSummaryRefreshCandidate,
  store: Pick<PrSummaryRefreshWorkerStore, 'loadWorkflow' | 'loadTasks' | 'listWorkerActions'>,
): string {
  const workflow = store.loadWorkflow?.(candidate.workflowId);
  const tasks = store.loadTasks(candidate.workflowId);
  const structuredContext = buildPrSummaryAuthoringContext(candidate.workflowId, workflow, tasks, store);
  const summary = workflow?.description
    ?? candidate.mergeTask.config.summary
    ?? candidate.mergeTask.description
    ?? `Workflow ${candidate.workflowId}`;
  return buildCanonicalPrBody({
    title: workflow?.name ?? candidate.mergeTask.description,
    workflowSummary: summary,
    structuredContext,
  });
}

function buildPrSummaryAuthoringContext(
  workflowId: string,
  workflow: { name?: string; description?: string } | undefined,
  tasks: readonly TaskState[],
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkerActions'>,
): PrAuthoringContext {
  return {
    workflowName: workflow?.name,
    workflowDescription: workflow?.description,
    tasks: tasks
      .filter((task) => !task.config.isMergeNode)
      .map(taskToPrEntry),
    workerActions: workerActionsForWorkflow(workflowId, store),
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
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkerActions'>,
): PrAuthoringWorkerActionEntry[] {
  return (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((action) => {
      const reason = reasonFromPayload(action.payload);
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
        createdAt: action.createdAt,
        updatedAt: action.updatedAt,
      };
    });
}

function reasonFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function recordRefreshAction(
  options: PrSummaryRefreshWorkerOptions,
  candidate: PrSummaryRefreshCandidate,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): WorkerActionRecord | undefined {
  const externalKey = typeof payload.externalKey === 'string'
    ? payload.externalKey
    : prSummaryRefreshExternalKey(candidate);
  const existing = options.store.getWorkerAction?.(PR_SUMMARY_REFRESH_WORKER_KIND, externalKey);
  const action = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey,
    subjectType: 'review',
    subjectId: candidate.artifact.providerId ?? candidate.artifact.id,
    workflowId: candidate.workflowId,
    taskId: candidate.mergeTask.id,
    status,
    summary,
    reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    incrementAttempt: status === 'completed' || status === 'failed',
    payload: {
      reviewId: candidate.artifact.providerId ?? null,
      reviewUrl: candidate.artifact.url ?? null,
      artifactId: candidate.artifact.id,
      generation: candidate.artifact.generation,
      provider: candidate.artifact.provider ?? null,
      ...payload,
      externalKey: undefined,
    },
  });
  if (shouldLogTaskWorkerAction(existing, action)) {
    logTaskWorkerAction(options.store, candidate.mergeTask.id, action, {
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
      status,
      summary,
      externalKey,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      reviewId: candidate.artifact.providerId ?? null,
      reviewUrl: candidate.artifact.url ?? null,
    });
  }
  return action;
}

function shouldLogTaskWorkerAction(
  existing: WorkerActionRecord | undefined,
  action: WorkerActionRecord | undefined,
): boolean {
  if (!action) return true;
  if (!existing) return true;
  return existing.status !== action.status
    || existing.summary !== action.summary
    || existing.attemptCount !== action.attemptCount
    || reasonFromPayload(existing.payload) !== reasonFromPayload(action.payload);
}

function logTaskWorkerAction(
  store: Pick<PrSummaryRefreshWorkerStore, 'logEvent'>,
  taskId: string,
  action: WorkerActionRecord | undefined,
  fallback: Record<string, unknown>,
): void {
  store.logEvent?.(taskId, 'task.worker_action', {
    ...fallback,
    ...(action ? {
      id: action.id,
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      summary: action.summary,
      attemptCount: action.attemptCount,
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      completedAt: action.completedAt ?? null,
    } : {}),
  });
}

function prSummaryRefreshExternalKey(candidate: PrSummaryRefreshCandidate): string {
  return [
    'pr-summary-refresh',
    candidate.mergeTask.id,
    candidate.artifact.providerId ?? candidate.artifact.id,
    `g${candidate.artifact.generation}`,
  ].join(':');
}

function normalizeBodyForCompare(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

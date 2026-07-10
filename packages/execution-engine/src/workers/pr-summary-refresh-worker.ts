import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
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
const TASK_WORKER_ACTION_EVENT = 'task.worker_action';

interface PrSummaryWorkflow {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): PrSummaryWorkflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  mergeGateProvider?: MergeGateProvider;
  cwd: string;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  prSummaryRefresh?: Omit<PrSummaryRefreshWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

interface ReviewArtifactRef {
  providerId: string;
  url?: string;
  title?: string;
}

interface RefreshCandidate {
  workflowId: string;
  mergeTask: TaskState;
  artifacts: ReviewArtifactRef[];
}

function normalizeBodyForCompare(body: string): string {
  return body.replace(/\s+$/g, '');
}

function currentReviewArtifacts(task: TaskState): ReviewArtifactRef[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts
      .filter((artifact) =>
        artifact.providerId
        && artifact.generation === gate.activeGeneration
        && artifact.status !== 'discarded'
        && !artifact.discardedAt,
      )
      .map((artifact) => ({
        providerId: artifact.providerId!,
        ...(artifact.url ? { url: artifact.url } : {}),
        ...(artifact.title ? { title: artifact.title } : {}),
      }));
  }

  if (!task.execution.reviewId) return [];
  return [{
    providerId: task.execution.reviewId,
    ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
  }];
}

function listRefreshCandidates(store: PrSummaryRefreshWorkerStore): RefreshCandidate[] {
  const candidates: RefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (!task.config.isMergeNode) continue;
      const artifacts = currentReviewArtifacts(task);
      if (artifacts.length === 0) continue;
      candidates.push({
        workflowId: task.config.workflowId ?? workflow.id,
        mergeTask: task,
        artifacts,
      });
    }
  }
  return candidates;
}

function toTaskEntry(task: TaskState): PrAuthoringTaskEntry {
  return {
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function reasonFromWorkerAction(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function toPrWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = reasonFromWorkerAction(action);
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function buildStructuredContext(
  options: PrSummaryRefreshWorkerPolicyOptions,
  workflowId: string,
): PrAuthoringContext {
  const workflow = options.store.loadWorkflow?.(workflowId);
  const tasks = options.store.loadTasks(workflowId);
  const workerActions = (options.store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(toPrWorkerAction);

  return {
    ...(workflow?.name ? { workflowName: workflow.name } : {}),
    ...(workflow?.description ? { workflowDescription: workflow.description } : {}),
    tasks: tasks.filter((task) => !task.config.isMergeNode).map(toTaskEntry),
    ...(workerActions && workerActions.length > 0 ? { workerActions } : {}),
  };
}

function actionExternalKey(candidate: RefreshCandidate, providerId: string): string {
  return [
    'pr-summary-refresh',
    candidate.mergeTask.id,
    providerId,
    candidate.mergeTask.execution.generation ?? 0,
    candidate.mergeTask.execution.selectedAttemptId ?? 'no-attempt',
  ].join(':');
}

function recordPrSummaryAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: RefreshCandidate,
  artifact: ReviewArtifactRef,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> = {},
  incrementAttempt = false,
): WorkerActionRecord | undefined {
  const externalKey = actionExternalKey(candidate, artifact.providerId);
  const record = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: candidate.workflowId,
    taskId: candidate.mergeTask.id,
    subjectType: 'review',
    subjectId: artifact.providerId,
    externalKey,
    status,
    summary,
    payload: {
      reviewId: artifact.providerId,
      reviewUrl: artifact.url ?? null,
      title: artifact.title ?? null,
      generation: candidate.mergeTask.execution.generation ?? 0,
      selectedAttemptId: candidate.mergeTask.execution.selectedAttemptId ?? null,
      ...payload,
    },
    incrementAttempt,
  });

  if (record) {
    options.store.logEvent?.(candidate.mergeTask.id, TASK_WORKER_ACTION_EVENT, {
      actionId: record.id,
      workerKind: record.workerKind,
      actionType: record.actionType,
      status: record.status,
      summary: record.summary,
      subjectType: record.subjectType,
      subjectId: record.subjectId,
      reviewId: artifact.providerId,
      reviewUrl: artifact.url ?? null,
      reason: payload.reason ?? null,
    });
  }
  return record;
}

async function refreshArtifactBody(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: RefreshCandidate,
  artifact: ReviewArtifactRef,
  body: string,
): Promise<void> {
  const provider = options.mergeGateProvider;
  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordPrSummaryAction(
      options,
      candidate,
      artifact,
      'skipped',
      'Skipped PR summary refresh: provider body update unavailable',
      { reason: 'provider-unavailable' },
    );
    return;
  }

  recordPrSummaryAction(
    options,
    candidate,
    artifact,
    'running',
    'Refreshing PR summary',
    {},
    true,
  );

  const cwd = candidate.mergeTask.execution.workspacePath ?? options.cwd;
  const current = await provider.getReviewBody({ identifier: artifact.providerId, cwd });
  if (normalizeBodyForCompare(current) === normalizeBodyForCompare(body)) {
    recordPrSummaryAction(
      options,
      candidate,
      artifact,
      'skipped',
      'Skipped PR summary refresh: body already current',
      { reason: 'unchanged' },
    );
    return;
  }

  await provider.updateReviewBody({ identifier: artifact.providerId, cwd, body });
  recordPrSummaryAction(
    options,
    candidate,
    artifact,
    'completed',
    'Updated PR summary with pipeline actions',
  );
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.mergeGateProvider?.getReviewBody || !options.mergeGateProvider.updateReviewBody) {
      options.logger.debug?.('[worker:pr-summary-refresh] merge gate provider body update unavailable', {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const candidate of listRefreshCandidates(options.store)) {
      const workflow = options.store.loadWorkflow?.(candidate.workflowId);
      const structuredContext = buildStructuredContext(options, candidate.workflowId);
      const body = buildCanonicalPrBody({
        title: workflow?.name ?? candidate.workflowId,
        workflowSummary: workflow?.description ?? `Workflow ${candidate.workflowId}`,
        structuredContext,
      });

      for (const artifact of candidate.artifacts) {
        try {
          await refreshArtifactBody(options, candidate, artifact, body);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          recordPrSummaryAction(
            options,
            candidate,
            artifact,
            'failed',
            `Failed PR summary refresh: ${message}`,
            { reason: 'provider-error', error: message },
          );
          options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh ${artifact.providerId}: ${message}`, {
            module: 'pr-summary-refresh-worker',
            taskId: candidate.mergeTask.id,
            workflowId: candidate.workflowId,
          });
        }
      }
    }
  };
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes live PR bodies with the canonical pipeline summary and worker actions.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          mergeGateProvider: deps.mergeGateProvider,
          cwd: deps.cwd ?? process.cwd(),
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

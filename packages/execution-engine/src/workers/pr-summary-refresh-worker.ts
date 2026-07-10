import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

interface WorkflowSummaryInfo {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<WorkflowSummaryInfo>;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workflowId?: string; workerKind?: string; limit?: number; offset?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  mergeGateProvider?: MergeGateProvider;
  cwd: string;
  logger: Logger;
  now?: () => Date;
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

export interface PrSummaryRefreshCandidate {
  workflow: WorkflowSummaryInfo;
  mergeTask: TaskState;
  reviewId: string;
  providerId: string;
  reviewUrl?: string;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store as unknown as PrSummaryRefreshWorkerStore,
          mergeGateProvider: deps.mergeGateProvider,
          cwd: deps.cwd ?? process.cwd(),
        },
      }),
  });
  return registry;
}

function isCurrentReviewArtifact(
  gate: NonNullable<TaskState['execution']['reviewGate']>,
  artifact: NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number],
): boolean {
  return artifact.generation === gate.activeGeneration
    && artifact.status !== 'discarded'
    && !artifact.discardedAt;
}

function normalizeReviewIdentifier(value: string): string {
  const trimmed = value.trim();
  const issueMatch = /#(\d+)$/.exec(trimmed);
  return issueMatch?.[1] ?? trimmed;
}

export function listPrSummaryRefreshCandidates(
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkflows' | 'loadTasks'>,
): PrSummaryRefreshCandidate[] {
  const candidates: PrSummaryRefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    for (const task of store.loadTasks(workflow.id)) {
      if (!task.config.isMergeNode) continue;
      const gate = task.execution.reviewGate;
      if (gate) {
        for (const artifact of gate.artifacts) {
          if (!isCurrentReviewArtifact(gate, artifact)) continue;
          const reviewId = artifact.providerId ?? artifact.id;
          if (!reviewId) continue;
          candidates.push({
            workflow,
            mergeTask: task,
            reviewId,
            providerId: normalizeReviewIdentifier(reviewId),
            ...(artifact.url ? { reviewUrl: artifact.url } : {}),
          });
        }
        continue;
      }

      if (!task.execution.reviewId) continue;
      candidates.push({
        workflow,
        mergeTask: task,
        reviewId: task.execution.reviewId,
        providerId: normalizeReviewIdentifier(task.execution.reviewId),
        ...(task.execution.reviewUrl ? { reviewUrl: task.execution.reviewUrl } : {}),
      });
    }
  }
  return candidates;
}

function taskStatusForPrContext(task: TaskState): PrAuthoringTaskEntry['status'] {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  return 'skipped';
}

function reasonFromWorkerAction(action: WorkerActionRecord): string | undefined {
  const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? action.payload as Record<string, unknown>
    : {};
  return typeof payload.reason === 'string' ? payload.reason : undefined;
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
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    ...(action.agentName ? { agentName: action.agentName } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

export function buildPrSummaryRefreshContext(
  store: Pick<PrSummaryRefreshWorkerStore, 'loadTasks' | 'listWorkerActions'>,
  workflow: WorkflowSummaryInfo,
): PrAuthoringContext {
  const tasks = store.loadTasks(workflow.id)
    .filter((task) => !task.config.isMergeNode)
    .map((task): PrAuthoringTaskEntry => ({
      taskId: task.id,
      description: task.description,
      status: taskStatusForPrContext(task),
      ...(task.config.command ? { command: task.config.command } : {}),
    }));
  const workerActions = (store.listWorkerActions?.({ workflowId: workflow.id }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(toPrWorkerAction);

  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks,
    workerActions,
  };
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function equivalentBody(left: string, right: string): boolean {
  return left.trimEnd() === right.trimEnd();
}

function prSummaryActionExternalKey(candidate: PrSummaryRefreshCandidate): string {
  return [candidate.mergeTask.id, candidate.providerId].join(':');
}

function existingBodyHash(action: WorkerActionRecord | undefined): string | undefined {
  const payload = action?.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const hash = (payload as Record<string, unknown>).bodyHash;
  return typeof hash === 'string' ? hash : undefined;
}

function recordPrSummaryAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): WorkerActionRecord | undefined {
  const externalKey = prSummaryActionExternalKey(candidate);
  const existing = options.store.getWorkerAction?.(PR_SUMMARY_REFRESH_WORKER_KIND, externalKey);
  const now = options.now?.() ?? new Date();
  const nowIso = now.toISOString();
  const shouldIncrement = status === 'completed' || status === 'failed';
  const completed = status === 'completed' || status === 'failed' || status === 'skipped';
  const write: WorkerActionWrite = {
    id: existing?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${externalKey}`,
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: candidate.workflow.id,
    taskId: candidate.mergeTask.id,
    subjectType: 'review',
    subjectId: candidate.reviewId,
    externalKey,
    status,
    attemptCount: shouldIncrement ? (existing?.attemptCount ?? 0) + 1 : (existing?.attemptCount ?? 0),
    summary,
    payload: {
      reviewId: candidate.reviewId,
      providerId: candidate.providerId,
      reviewUrl: candidate.reviewUrl ?? null,
      workflowId: candidate.workflow.id,
      ...payload,
    },
    updatedAt: nowIso,
    ...(completed ? { completedAt: nowIso } : {}),
  };
  const saved = options.store.upsertWorkerAction?.(write);
  if (status === 'completed' || status === 'failed') {
    options.store.logEvent?.(candidate.mergeTask.id, 'task.worker_action', {
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
      status,
      summary,
      workflowId: candidate.workflow.id,
      reviewId: candidate.reviewId,
      reviewUrl: candidate.reviewUrl ?? null,
      subjectType: 'review',
      subjectId: candidate.reviewId,
      reason: typeof payload.reason === 'string' ? payload.reason : undefined,
    });
  }
  return saved;
}

async function refreshCandidate(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
): Promise<void> {
  const provider = options.mergeGateProvider;
  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordPrSummaryAction(options, candidate, 'skipped', 'Skipped PR summary refresh: provider cannot update review bodies', {
      reason: 'provider-update-unavailable',
    });
    return;
  }

  const context = buildPrSummaryRefreshContext(options.store, candidate.workflow);
  const workflowSummary = candidate.workflow.description
    ?? candidate.workflow.name
    ?? candidate.mergeTask.description
    ?? candidate.workflow.id;
  const desiredBody = buildCanonicalPrBody({
    title: candidate.workflow.name ?? candidate.mergeTask.description,
    workflowSummary,
    structuredContext: context,
  });
  const hash = bodyHash(desiredBody);
  const existingAction = options.store.getWorkerAction?.(
    PR_SUMMARY_REFRESH_WORKER_KIND,
    prSummaryActionExternalKey(candidate),
  );

  let liveBody: string;
  try {
    liveBody = await provider.getReviewBody({ identifier: candidate.providerId, cwd: options.cwd });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPrSummaryAction(options, candidate, 'failed', `Failed to read PR summary: ${message}`, {
      reason: 'provider-read-failed',
      bodyHash: hash,
      error: message,
    });
    options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to read PR body`, {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflow.id,
      taskId: candidate.mergeTask.id,
      reviewId: candidate.reviewId,
      err,
    });
    return;
  }
  if (equivalentBody(liveBody, desiredBody)) {
    if (existingBodyHash(existingAction) === hash) return;
    recordPrSummaryAction(options, candidate, 'skipped', 'PR summary already up to date', {
      reason: 'body-unchanged',
      bodyHash: hash,
    });
    return;
  }

  try {
    await provider.updateReviewBody({ identifier: candidate.providerId, cwd: options.cwd, body: desiredBody });
    recordPrSummaryAction(options, candidate, 'completed', 'Refreshed PR summary with worker pipeline actions', {
      bodyHash: hash,
      previousBodyHash: bodyHash(liveBody),
      workerActionCount: context.workerActions?.length ?? 0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordPrSummaryAction(options, candidate, 'failed', `Failed to refresh PR summary: ${message}`, {
      reason: 'provider-update-failed',
      bodyHash: hash,
      error: message,
    });
    options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR body`, {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflow.id,
      taskId: candidate.mergeTask.id,
      reviewId: candidate.reviewId,
      err,
    });
  }
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    const candidates = listPrSummaryRefreshCandidates(options.store);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      const key = prSummaryActionExternalKey(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      await refreshCandidate(options, candidate);
    }
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

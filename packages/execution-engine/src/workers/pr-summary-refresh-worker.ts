import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
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

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{
    id: string;
    name?: string;
    description?: string;
    repoUrl?: string;
  }>;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions?(filters?: { workflowId?: string; taskId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  provider: Pick<MergeGateProvider, 'name' | 'getReviewBody' | 'updateReviewBody'>;
  logger: Logger;
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
  workflowId: string;
  workflowName?: string;
  workflowDescription?: string;
  task: TaskState;
  artifact: ReviewGateArtifact;
  cwd: string;
}

function isCurrentReviewArtifact(gate: ReviewGateState, artifact: ReviewGateArtifact): boolean {
  return artifact.generation === gate.activeGeneration
    && artifact.status !== 'discarded'
    && artifact.status !== 'closed'
    && !artifact.discardedAt;
}

export function listPrSummaryRefreshCandidates(
  store: PrSummaryRefreshWorkerStore,
  providerName: string,
): PrSummaryRefreshCandidate[] {
  const candidates: PrSummaryRefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    const tasks = store.loadTasks(workflow.id);
    for (const task of tasks) {
      if (!task.config.isMergeNode) continue;
      if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') continue;
      const gate = task.execution.reviewGate;
      if (!gate) continue;
      const cwd = task.execution.workspacePath;
      if (!cwd) continue;
      for (const artifact of gate.artifacts) {
        if (!isCurrentReviewArtifact(gate, artifact)) continue;
        if (!artifact.providerId || !artifact.url) continue;
        if (artifact.provider && artifact.provider !== providerName) continue;
        candidates.push({
          workflowId: workflow.id,
          workflowName: workflow.name,
          workflowDescription: workflow.description,
          task,
          artifact,
          cwd,
        });
      }
    }
  }
  return candidates;
}

function taskEntryFromTask(task: TaskState): PrAuthoringTaskEntry {
  const status: PrAuthoringTaskEntry['status'] =
    task.status === 'completed'
      ? 'completed'
      : task.status === 'failed'
        ? 'failed'
        : 'skipped';
  return {
    taskId: task.id,
    description: task.description,
    status,
    ...(task.config.command ? { command: task.config.command } : {}),
    ...(task.config.summary ? { fileChangeSummary: task.config.summary } : {}),
  };
}

function reasonFromWorkerAction(action: WorkerActionRecord): string | undefined {
  const payload = action.payload;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function authoringWorkerActionFromRecord(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
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
    ...(reasonFromWorkerAction(action) ? { reason: reasonFromWorkerAction(action) } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function actionTime(action: PrAuthoringWorkerActionEntry): string {
  return action.createdAt || action.updatedAt || action.completedAt || '';
}

function buildPrSummaryAuthoringContext(
  store: PrSummaryRefreshWorkerStore,
  candidate: PrSummaryRefreshCandidate,
): PrAuthoringContext {
  const tasks = store.loadTasks(candidate.workflowId)
    .filter((task) => !task.config.isMergeNode)
    .map(taskEntryFromTask);
  const workerActions = (store.listWorkerActions?.({ workflowId: candidate.workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(authoringWorkerActionFromRecord)
    .sort((a, b) => actionTime(a).localeCompare(actionTime(b)) || a.id.localeCompare(b.id));

  return {
    workflowName: candidate.workflowName,
    workflowDescription: candidate.workflowDescription,
    tasks,
    workerActions,
  };
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function normalizeBodyForCompare(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function actionExternalKey(candidate: PrSummaryRefreshCandidate): string {
  return [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    candidate.task.id,
    candidate.artifact.generation,
    candidate.artifact.providerId ?? candidate.artifact.id,
  ].join(':');
}

function recordPrSummaryAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  status: WorkerActionRecord['status'],
  summary: string,
  payload: Record<string, unknown> = {},
  incrementAttempt = false,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: candidate.workflowId,
    taskId: candidate.task.id,
    subjectType: 'review',
    subjectId: candidate.artifact.providerId ?? candidate.artifact.id,
    externalKey: actionExternalKey(candidate),
    status,
    summary,
    incrementAttempt,
    payload: {
      reviewId: candidate.artifact.providerId ?? null,
      reviewUrl: candidate.artifact.url ?? null,
      artifactId: candidate.artifact.id,
      generation: candidate.artifact.generation,
      ...payload,
    },
  });
}

function logWorkerActionEvent(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  record: WorkerActionRecord | undefined,
  details: Record<string, unknown>,
): void {
  options.store.logEvent?.(candidate.task.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: candidate.workflowId,
    reviewId: candidate.artifact.providerId ?? null,
    reviewUrl: candidate.artifact.url ?? null,
    status: record?.status ?? details.status,
    summary: record?.summary ?? details.summary,
    actionId: record?.id,
    ...details,
  });
}

async function refreshCandidate(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
): Promise<void> {
  const providerId = candidate.artifact.providerId;
  if (!providerId) return;
  if (!options.provider.getReviewBody || !options.provider.updateReviewBody) {
    const record = recordPrSummaryAction(
      options,
      candidate,
      'skipped',
      'Skipped PR summary refresh: provider cannot read or update bodies',
      { reason: 'provider-body-update-unavailable' },
    );
    logWorkerActionEvent(options, candidate, record, { reason: 'provider-body-update-unavailable' });
    return;
  }

  const context = buildPrSummaryAuthoringContext(options.store, candidate);
  const workflowSummary = candidate.workflowDescription
    ?? candidate.workflowName
    ?? `Workflow ${candidate.workflowId}`;
  const nextBody = buildCanonicalPrBody({
    title: candidate.workflowName ?? 'Workflow',
    workflowSummary,
    structuredContext: context,
  });
  const currentBody = await options.provider.getReviewBody({ identifier: providerId, cwd: candidate.cwd });
  const currentHash = bodyHash(normalizeBodyForCompare(currentBody));
  const nextHash = bodyHash(normalizeBodyForCompare(nextBody));

  if (currentHash === nextHash) {
    const record = recordPrSummaryAction(
      options,
      candidate,
      'skipped',
      'PR summary already up to date',
      { reason: 'unchanged', bodyHash: nextHash },
    );
    logWorkerActionEvent(options, candidate, record, { reason: 'unchanged', bodyHash: nextHash });
    return;
  }

  const running = recordPrSummaryAction(
    options,
    candidate,
    'running',
    'Refreshing PR summary',
    { previousBodyHash: currentHash, nextBodyHash: nextHash },
  );
  logWorkerActionEvent(options, candidate, running, {
    previousBodyHash: currentHash,
    nextBodyHash: nextHash,
  });

  await options.provider.updateReviewBody({ identifier: providerId, cwd: candidate.cwd, body: nextBody });
  const completed = recordPrSummaryAction(
    options,
    candidate,
    'completed',
    'Updated PR summary with pipeline actions',
    {
      previousBodyHash: currentHash,
      nextBodyHash: nextHash,
      workerActionCount: context.workerActions?.length ?? 0,
    },
    true,
  );
  logWorkerActionEvent(options, candidate, completed, {
    previousBodyHash: currentHash,
    nextBodyHash: nextHash,
    workerActionCount: context.workerActions?.length ?? 0,
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    const candidates = listPrSummaryRefreshCandidates(options.store, options.provider.name);
    for (const candidate of candidates) {
      try {
        await refreshCandidate(options, candidate);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const record = recordPrSummaryAction(
          options,
          candidate,
          'failed',
          `Failed to refresh PR summary: ${message}`,
          { error: message },
          true,
        );
        logWorkerActionEvent(options, candidate, record, { error: message });
        options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] refresh failed`, {
          module: 'pr-summary-refresh-worker',
          workflowId: candidate.workflowId,
          taskId: candidate.task.id,
          reviewId: candidate.artifact.providerId,
          err,
        });
      }
    }
  };
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  const provider = options.prSummaryRefresh?.provider ?? new GitHubMergeGateProvider();
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
          provider,
          logger: options.logger,
        })
        : (() => {})
    ),
  });
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the canonical Pipeline summary of worker actions.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          provider: new GitHubMergeGateProvider(),
        },
      }),
  });
  return registry;
}

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import { buildCanonicalPrBody, type PrAuthoringContext, type PrAuthoringWorkerActionEntry } from '../pr-authoring.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

export interface PrSummaryRefreshWorkflow {
  id: string;
  name?: string;
  description?: string;
  reviewProvider?: string;
}

export interface PrSummaryRefreshStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflow>;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: { workflowId?: string; taskId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  intervalMs?: number;
  cwd?: string;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  store: PrSummaryRefreshStore;
  logger: Logger;
  mergeGateProvider?: MergeGateProvider;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshTickOptions {
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

interface ReviewBodyCandidate {
  workflow: PrSummaryRefreshWorkflow;
  mergeTask: TaskState;
  provider: string;
  identifier?: string;
  url?: string;
  artifactId: string;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes published PR bodies with Invoker pipeline and worker-action summaries.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        mergeGateProvider: deps.mergeGateProvider,
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
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? createPrSummaryRefreshTick(options),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async (ctx) => {
    const cwd = options.cwd ?? process.cwd();
    for (const workflow of options.store.listWorkflows()) {
      ctx.signal.throwIfAborted();
      const tasks = options.store.loadTasks(workflow.id);
      const candidates = findReviewBodyCandidates(workflow, tasks);
      for (const candidate of candidates) {
        ctx.signal.throwIfAborted();
        await refreshCandidate(options, candidate, tasks, cwd);
      }
    }
  };
}

function findReviewBodyCandidates(
  workflow: PrSummaryRefreshWorkflow,
  tasks: readonly TaskState[],
): ReviewBodyCandidate[] {
  const candidates: ReviewBodyCandidate[] = [];
  for (const task of tasks) {
    if (!task.config.isMergeNode) continue;
    const gate = task.execution.reviewGate;
    if (gate) {
      for (const artifact of gate.artifacts) {
        if (artifact.generation !== gate.activeGeneration) continue;
        if (artifact.discardedAt || artifact.status === 'discarded') continue;
        if (artifact.status === 'closed' || artifact.status === 'merged') continue;
        const url = artifact.url ?? task.execution.reviewUrl;
        candidates.push({
          workflow,
          mergeTask: task,
          provider: artifact.provider ?? workflow.reviewProvider ?? 'github',
          identifier: artifact.providerId ?? parseGitHubPullRequestNumber(url),
          url,
          artifactId: artifact.id,
        });
      }
      continue;
    }

    if (task.execution.reviewId || task.execution.reviewUrl) {
      const url = task.execution.reviewUrl;
      candidates.push({
        workflow,
        mergeTask: task,
        provider: workflow.reviewProvider ?? 'github',
        identifier: task.execution.reviewProviderId ?? task.execution.reviewId ?? parseGitHubPullRequestNumber(url),
        url,
        artifactId: task.execution.reviewId ?? url ?? task.id,
      });
    }
  }
  return candidates;
}

async function refreshCandidate(
  options: PrSummaryRefreshTickOptions,
  candidate: ReviewBodyCandidate,
  tasks: readonly TaskState[],
  cwd: string,
): Promise<void> {
  const externalKey = prSummaryRefreshExternalKey(candidate);
  const provider = options.mergeGateProvider;
  if (!candidate.identifier) {
    recordRefreshAction(options, candidate, externalKey, 'skipped', 'Skipped PR summary refresh: missing review identifier', {
      reason: 'missing-review-identifier',
    });
    return;
  }
  if (!provider || provider.name !== candidate.provider || !provider.getReviewBody || !provider.updateReviewBody) {
    recordRefreshAction(options, candidate, externalKey, 'skipped', 'Skipped PR summary refresh: provider does not support body updates', {
      reason: 'provider-unsupported',
    });
    return;
  }

  try {
    const desiredBody = buildCanonicalPrBody({
      title: candidate.workflow.name ?? 'Workflow',
      workflowSummary: candidate.workflow.description ?? candidate.workflow.name ?? candidate.workflow.id,
      structuredContext: buildStructuredContext(options.store, candidate.workflow, tasks),
    });
    const currentBody = await provider.getReviewBody({ identifier: candidate.identifier, cwd });
    if (bodyEqual(currentBody, desiredBody)) {
      recordRefreshAction(options, candidate, externalKey, 'skipped', 'PR summary already up to date', {
        reason: 'unchanged',
      });
      return;
    }

    recordWorkerDecisionRow(options.store, {
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
      workflowId: candidate.workflow.id,
      taskId: candidate.mergeTask.id,
      externalKey,
      subjectType: 'pull_request',
      subjectId: candidate.url ?? candidate.identifier,
      status: 'running',
      summary: 'Refreshing PR summary',
      incrementAttempt: true,
      payload: actionPayload(candidate),
    });
    await provider.updateReviewBody({ identifier: candidate.identifier, cwd, body: desiredBody });
    recordRefreshAction(options, candidate, externalKey, 'completed', 'Updated PR summary with current Invoker pipeline', {
      changed: true,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordRefreshAction(options, candidate, externalKey, 'failed', `PR summary refresh failed: ${message}`, {
      reason: 'provider-error',
      error: message,
    });
    options.logger.warn('[worker:pr-summary-refresh] failed to refresh PR summary', {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflow.id,
      taskId: candidate.mergeTask.id,
      provider: candidate.provider,
      identifier: candidate.identifier,
      err,
    });
  }
}

function buildStructuredContext(
  store: PrSummaryRefreshStore,
  workflow: PrSummaryRefreshWorkflow,
  tasks: readonly TaskState[],
): PrAuthoringContext {
  const nonMergeTasks = tasks.filter((task) => !task.config.isMergeNode);
  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks: nonMergeTasks.map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      command: task.config.command,
    })),
    workerActions: collectPipelineWorkerActions(store, workflow.id),
  };
}

function collectPipelineWorkerActions(
  store: PrSummaryRefreshStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  return (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((action) => {
      const reason = workerActionReason(action.payload);
      return {
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
    });
}

function recordRefreshAction(
  options: PrSummaryRefreshTickOptions,
  candidate: ReviewBodyCandidate,
  externalKey: string,
  status: 'completed' | 'failed' | 'skipped',
  summary: string,
  payload?: Record<string, unknown>,
): void {
  const saved = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: candidate.workflow.id,
    taskId: candidate.mergeTask.id,
    externalKey,
    subjectType: 'pull_request',
    subjectId: candidate.url ?? candidate.identifier ?? candidate.artifactId,
    status,
    summary,
    payload: {
      ...actionPayload(candidate),
      ...payload,
    },
  });
  emitWorkerActionEvent(options.store, candidate.mergeTask.id, saved, summary, payload);
}

function emitWorkerActionEvent(
  store: PrSummaryRefreshStore,
  taskId: string,
  action: WorkerActionRecord | undefined,
  fallbackSummary: string,
  payload: Record<string, unknown> | undefined,
): void {
  store.logEvent?.(taskId, 'task.worker_action', {
    workerKind: action?.workerKind ?? PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: action?.actionType ?? PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: action?.status,
    summary: action?.summary ?? fallbackSummary,
    externalKey: action?.externalKey,
    workflowId: action?.workflowId,
    taskId: action?.taskId ?? taskId,
    subjectType: action?.subjectType,
    subjectId: action?.subjectId,
    ...(payload?.reason ? { reason: payload.reason } : {}),
  });
}

function actionPayload(candidate: ReviewBodyCandidate): Record<string, unknown> {
  return {
    provider: candidate.provider,
    artifactId: candidate.artifactId,
    ...(candidate.identifier ? { identifier: candidate.identifier } : {}),
    ...(candidate.url ? { reviewUrl: candidate.url } : {}),
  };
}

function prSummaryRefreshExternalKey(candidate: ReviewBodyCandidate): string {
  return [
    candidate.workflow.id,
    candidate.mergeTask.id,
    candidate.provider,
    candidate.identifier ?? candidate.url ?? candidate.artifactId,
  ].join(':');
}

function parseGitHubPullRequestNumber(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const match = /^https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)(?:[/?#].*)?$/i.exec(url);
  return match?.[1];
}

function bodyEqual(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

function workerActionReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite, Workflow } from '@invoker/data-store';
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
import { getCurrentRequiredReviewArtifacts } from '../task-runner-review-gate.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'pr-summary-refresh';
const TASK_WORKER_ACTION_EVENT = 'task.worker_action';

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<Pick<Workflow, 'id'> & Partial<Workflow>>;
  loadTasks(workflowId: string): TaskState[];
  loadWorkflow?(workflowId: string): Workflow | undefined;
  listWorkerActions?(filters?: { workflowId?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  provider?: MergeGateProvider;
  cwd?: string;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshWorkerStore;
}

interface ReviewCandidate {
  workflow: (Pick<Workflow, 'id'> & Partial<Workflow>) | undefined;
  workflowId: string;
  task: TaskState;
  identifier: string;
  reviewUrl?: string;
  title: string;
  cwd: string;
  generation: number;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes PR bodies with canonical Invoker Pipeline worker-action summaries.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        provider: deps.prSummaryRefresh?.provider,
        cwd: deps.prSummaryRefresh?.cwd,
        intervalMs: deps.prSummaryRefresh?.intervalMs,
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
      provider: options.provider,
      cwd: options.cwd,
    }),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export async function refreshPrSummaries(options: PrSummaryRefreshTickOptions): Promise<void> {
  const provider = options.provider;
  const getReviewBody = provider?.getReviewBody;
  const updateReviewBody = provider?.updateReviewBody;
  if (!provider || !getReviewBody || !updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] review body provider unavailable', {
      module: 'pr-summary-refresh-worker',
    });
    return;
  }
  const bodyProvider = {
    getReviewBody: getReviewBody.bind(provider),
    updateReviewBody: updateReviewBody.bind(provider),
  };

  const candidates = collectPrSummaryRefreshCandidates(options);
  for (const candidate of candidates) {
    await refreshOneCandidate(options, candidate, bodyProvider);
  }
}

export function collectPrSummaryRefreshCandidates(
  options: Pick<PrSummaryRefreshTickOptions, 'store' | 'cwd'>,
): ReviewCandidate[] {
  const candidates: ReviewCandidate[] = [];
  const workflows = options.store.listWorkflows();
  const workflowById = new Map(workflows.map((workflow) => [workflow.id, workflow]));

  for (const workflow of workflows) {
    const tasks = options.store.loadTasks(workflow.id);
    for (const task of tasks) {
      if (!task.config.isMergeNode) continue;
      if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') continue;
      const artifacts = getCurrentRequiredReviewArtifacts(task);
      for (const artifact of artifacts) {
        if (!artifact.providerId) continue;
        candidates.push({
          workflow,
          workflowId: workflow.id,
          task,
          identifier: artifact.providerId,
          reviewUrl: artifact.url ?? task.execution.reviewUrl,
          title: artifact.title ?? workflow.name ?? task.description,
          cwd: task.execution.workspacePath ?? options.cwd ?? process.cwd(),
          generation: artifact.generation,
        });
      }
    }
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = `${candidate.workflowId}:${candidate.identifier}:${candidate.generation}`;
    if (seen.has(key)) return false;
    seen.add(key);
    candidate.workflow = candidate.workflow ?? workflowById.get(candidate.workflowId);
    return true;
  });
}

async function refreshOneCandidate(
  options: PrSummaryRefreshTickOptions,
  candidate: ReviewCandidate,
  provider: Required<Pick<MergeGateProvider, 'getReviewBody' | 'updateReviewBody'>>,
): Promise<void> {
  const externalKey = `${candidate.workflowId}:${candidate.identifier}:g${candidate.generation}`;
  try {
    const body = buildPrSummaryBody(options.store, candidate);
    const current = await provider.getReviewBody({ identifier: candidate.identifier, cwd: candidate.cwd });
    if (current.trimEnd() === body.trimEnd()) {
      recordPrSummaryRefreshAction(options, {
        candidate,
        externalKey,
        status: 'skipped',
        summary: `PR body already current for ${candidate.identifier}`,
        reason: 'content-unchanged',
        body,
      });
      return;
    }

    await provider.updateReviewBody({ identifier: candidate.identifier, cwd: candidate.cwd, body });
    recordPrSummaryRefreshAction(options, {
      candidate,
      externalKey,
      status: 'completed',
      summary: `Refreshed PR Pipeline summary for ${candidate.identifier}`,
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    options.logger.warn(`[worker:pr-summary-refresh] failed to refresh PR ${candidate.identifier}`, {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflowId,
      taskId: candidate.task.id,
      reviewId: candidate.identifier,
      err,
    });
    recordPrSummaryRefreshAction(options, {
      candidate,
      externalKey,
      status: 'failed',
      summary: `Failed to refresh PR Pipeline summary for ${candidate.identifier}`,
      reason: message,
    });
  }
}

function buildPrSummaryBody(
  store: PrSummaryRefreshWorkerStore,
  candidate: ReviewCandidate,
): string {
  const workflow = store.loadWorkflow?.(candidate.workflowId) ?? candidate.workflow;
  const structuredContext = buildPrSummaryAuthoringContext(store, candidate.workflowId);
  const workflowSummary =
    workflow?.description
    ?? candidate.task.config.summary
    ?? candidate.task.description
    ?? candidate.title;

  return buildCanonicalPrBody({
    title: candidate.title,
    workflowSummary,
    structuredContext: {
      ...structuredContext,
      workflowName: workflow?.name ?? structuredContext.workflowName,
      workflowDescription: workflow?.description ?? structuredContext.workflowDescription,
    },
  });
}

export function buildPrSummaryAuthoringContext(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringContext {
  const workflow = store.loadWorkflow?.(workflowId) ?? store.listWorkflows().find((candidate) => candidate.id === workflowId);
  const tasks: PrAuthoringTaskEntry[] = store.loadTasks(workflowId)
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      ...(task.config.command ? { command: task.config.command } : {}),
    }));

  return {
    workflowName: workflow?.name,
    workflowDescription: workflow?.description,
    tasks,
    workerActions: listPipelineWorkerActions(store, workflowId),
  };
}

export function listPipelineWorkerActions(
  store: Pick<PrSummaryRefreshWorkerStore, 'listWorkerActions'>,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  const actions = store.listWorkerActions?.({ workflowId }) ?? [];
  return actions
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map((action) => {
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
        ...(action.summary ? { summary: action.summary } : {}),
        ...(reason ? { reason } : {}),
        ...(action.taskId ? { taskId: action.taskId } : {}),
        updatedAt: action.updatedAt,
      };
    });
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshTickOptions,
  args: {
    candidate: ReviewCandidate;
    externalKey: string;
    status: 'completed' | 'failed' | 'skipped';
    summary: string;
    reason?: string;
    body?: string;
  },
): void {
  const payload = {
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.candidate.reviewUrl ? { reviewUrl: args.candidate.reviewUrl } : {}),
    reviewId: args.candidate.identifier,
    generation: args.candidate.generation,
    ...(args.body ? { bodySha256: sha256(args.body) } : {}),
  };
  const record = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: args.externalKey,
    workflowId: args.candidate.workflowId,
    taskId: args.candidate.task.id,
    subjectType: 'pull_request',
    subjectId: args.candidate.identifier,
    status: args.status,
    summary: args.summary,
    ...(args.reason ? { reason: args.reason } : {}),
    payload,
    incrementAttempt: args.status === 'completed' || args.status === 'failed',
  });

  options.store.logEvent?.(args.candidate.task.id, TASK_WORKER_ACTION_EVENT, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: args.status,
    summary: args.summary,
    subjectType: 'pull_request',
    subjectId: args.candidate.identifier,
    externalKey: args.externalKey,
    ...(args.reason ? { reason: args.reason } : {}),
    ...(args.candidate.reviewUrl ? { reviewUrl: args.candidate.reviewUrl } : {}),
    ...(record ? { workerActionId: record.id } : {}),
  });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

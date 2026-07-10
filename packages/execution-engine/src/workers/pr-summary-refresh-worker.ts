import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkerActionListFilters, WorkerActionRecord } from '@invoker/data-store';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  upsertPrPipelineSection,
  validateCanonicalPrBody,
  validateReviewStackPrBody,
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
const TERMINAL_REVIEW_ARTIFACT_STATUSES = new Set(['merged', 'closed', 'discarded']);

export interface PrSummaryRefreshWorkflowRow {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore extends WorkerDecisionStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflowRow>;
  loadWorkflow?(workflowId: string): PrSummaryRefreshWorkflowRow | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  provider?: MergeGateProvider;
  intervalMs?: number;
  cwd?: string;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store?: PrSummaryRefreshWorkerStore;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store?: PrSummaryRefreshWorkerStore;
}

interface ReviewTarget {
  identifier: string;
  url?: string;
  provider?: string;
}

type ReviewBodyProvider = MergeGateProvider & Required<Pick<MergeGateProvider, 'getReviewBody' | 'updateReviewBody'>>;

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR summaries with the latest Invoker worker pipeline activity.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        provider: deps.prSummaryRefresh?.provider,
        intervalMs: deps.prSummaryRefresh?.intervalMs,
        cwd: deps.prSummaryRefresh?.cwd,
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
      intervalMs: options.intervalMs,
      cwd: options.cwd,
    }),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async () => {
    await refreshPrSummaries(options);
  };
}

export function renderPrSummaryRefreshBody(args: {
  existingBody: string;
  workflowTitle: string;
  workflowSummary: string;
  structuredContext: PrAuthoringContext;
}): string {
  const canonicalBody = buildCanonicalPrBody({
    title: args.workflowTitle,
    workflowSummary: args.workflowSummary,
    structuredContext: args.structuredContext,
  });
  const existing = args.existingBody.trimEnd();
  if (
    existing
    && (
      validateCanonicalPrBody(existing).length === 0
      || validateReviewStackPrBody(existing).length === 0
    )
  ) {
    return upsertPrPipelineSection(existing, args.structuredContext.workerActions);
  }
  return canonicalBody;
}

async function refreshPrSummaries(options: PrSummaryRefreshTickOptions): Promise<void> {
  const { store, provider } = options;
  if (!store) {
    options.logger.debug?.('[worker:pr-summary-refresh] store dependency unavailable', {
      module: 'pr-summary-refresh-worker',
    });
    return;
  }
  if (!isReviewBodyProvider(provider)) {
    options.logger.debug?.('[worker:pr-summary-refresh] provider body API unavailable', {
      module: 'pr-summary-refresh-worker',
      provider: provider?.name ?? 'none',
    });
    return;
  }

  for (const workflowRef of store.listWorkflows()) {
    const workflow = store.loadWorkflow?.(workflowRef.id) ?? workflowRef;
    const tasks = store.loadTasks(workflowRef.id);
    const mergeTasks = tasks.filter((task) => task.config.isMergeNode);
    if (mergeTasks.length === 0) continue;

    const structuredContext = buildStructuredContextForRefresh(store, workflow, tasks);
    for (const task of mergeTasks) {
      for (const target of reviewTargetsForTask(task, provider.name)) {
        await refreshOneReview({
          ...options,
          store,
          provider,
          workflow,
          task,
          target,
          structuredContext,
        });
      }
    }
  }
}

async function refreshOneReview(options: PrSummaryRefreshTickOptions & {
  store: PrSummaryRefreshWorkerStore;
  provider: ReviewBodyProvider;
  workflow: PrSummaryRefreshWorkflowRow;
  task: TaskState;
  target: ReviewTarget;
  structuredContext: PrAuthoringContext;
}): Promise<void> {
  const cwd = options.cwd ?? options.task.execution.workspacePath ?? process.cwd();
  const externalKey = `${options.workflow.id}:${options.task.id}:${options.target.identifier}`;
  const commonPayload = {
    provider: options.provider.name,
    reviewId: options.target.identifier,
    ...(options.target.url ? { reviewUrl: options.target.url } : {}),
  };

  try {
    const existingBody = await options.provider.getReviewBody({
      identifier: options.target.identifier,
      cwd,
    });
    const desiredBody = renderPrSummaryRefreshBody({
      existingBody,
      workflowTitle: options.workflow.name ?? options.workflow.id,
      workflowSummary: options.workflow.description ?? `Invoker workflow ${options.workflow.name ?? options.workflow.id}.`,
      structuredContext: options.structuredContext,
    });

    if (existingBody.trimEnd() === desiredBody.trimEnd()) {
      recordAndLogWorkerAction(options.store, {
        externalKey,
        workflowId: options.workflow.id,
        taskId: options.task.id,
        subjectId: options.target.identifier,
        status: 'skipped',
        summary: 'PR summary already current',
        reason: 'body-unchanged',
        payload: { ...commonPayload, changed: false },
      });
      return;
    }

    recordWorkerDecisionRow(options.store, {
      workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
      actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
      externalKey,
      subjectType: 'pull_request',
      subjectId: options.target.identifier,
      workflowId: options.workflow.id,
      taskId: options.task.id,
      status: 'running',
      summary: 'Refreshing PR summary',
      payload: commonPayload,
      incrementAttempt: true,
    });

    await options.provider.updateReviewBody({
      identifier: options.target.identifier,
      cwd,
      body: desiredBody,
    });

    recordAndLogWorkerAction(options.store, {
      externalKey,
      workflowId: options.workflow.id,
      taskId: options.task.id,
      subjectId: options.target.identifier,
      status: 'completed',
      summary: 'Refreshed PR summary',
      payload: { ...commonPayload, changed: true },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordAndLogWorkerAction(options.store, {
      externalKey,
      workflowId: options.workflow.id,
      taskId: options.task.id,
      subjectId: options.target.identifier,
      status: 'failed',
      summary: 'Failed to refresh PR summary',
      reason: message,
      payload: { ...commonPayload, changed: false, error: message },
      incrementAttempt: true,
    });
    options.logger.warn?.('[worker:pr-summary-refresh] refresh failed', {
      module: 'pr-summary-refresh-worker',
      workflowId: options.workflow.id,
      taskId: options.task.id,
      reviewId: options.target.identifier,
      err,
    });
  }
}

function isReviewBodyProvider(provider: MergeGateProvider | undefined): provider is ReviewBodyProvider {
  return Boolean(provider?.getReviewBody && provider.updateReviewBody);
}

function recordAndLogWorkerAction(
  store: PrSummaryRefreshWorkerStore,
  args: {
    externalKey: string;
    workflowId: string;
    taskId: string;
    subjectId: string;
    status: 'completed' | 'failed' | 'skipped';
    summary: string;
    reason?: string;
    payload?: Record<string, unknown>;
    incrementAttempt?: boolean;
  },
): void {
  const action = recordWorkerDecisionRow(store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: args.externalKey,
    subjectType: 'pull_request',
    subjectId: args.subjectId,
    workflowId: args.workflowId,
    taskId: args.taskId,
    status: args.status,
    summary: args.summary,
    reason: args.reason,
    payload: args.payload,
    incrementAttempt: args.incrementAttempt,
  });
  store.logEvent?.(args.taskId, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    status: args.status,
    summary: args.summary,
    ...(args.reason ? { reason: args.reason } : {}),
    workflowId: args.workflowId,
    taskId: args.taskId,
    subjectType: 'pull_request',
    subjectId: args.subjectId,
    externalKey: args.externalKey,
    ...(action ? { workerActionId: action.id } : {}),
    ...args.payload,
  });
}

function buildStructuredContextForRefresh(
  store: PrSummaryRefreshWorkerStore,
  workflow: PrSummaryRefreshWorkflowRow,
  tasks: readonly TaskState[],
): PrAuthoringContext {
  const workflowTasks = tasks.filter((task) => !task.config.isMergeNode);
  const entries: PrAuthoringTaskEntry[] = workflowTasks.map((task) => ({
    taskId: task.id,
    description: task.description,
    status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
    ...(task.config.command ? { command: task.config.command } : {}),
  }));
  return {
    workflowName: workflow.name,
    workflowDescription: workflow.description,
    tasks: entries,
    workerActions: listPipelineWorkerActions(store, workflow.id),
  };
}

function listPipelineWorkerActions(
  store: PrSummaryRefreshWorkerStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  const actions = store.listWorkerActions?.({ workflowId }) ?? [];
  return actions
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(workerActionToPrEntry);
}

function workerActionToPrEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = workerActionReason(action.payload);
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.workflowId ? { workflowId: action.workflowId } : {}),
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(reason ? { reason } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function workerActionReason(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim() ? reason : undefined;
}

function reviewTargetsForTask(task: TaskState, providerName: string): ReviewTarget[] {
  const reviewGate = task.execution.reviewGate;
  if (reviewGate?.artifacts.length) {
    return reviewGate.artifacts
      .filter((artifact) => artifact.required)
      .filter((artifact) => artifact.generation === reviewGate.activeGeneration)
      .filter((artifact) => !TERMINAL_REVIEW_ARTIFACT_STATUSES.has(artifact.status))
      .filter((artifact) => !artifact.provider || artifact.provider === providerName)
      .map((artifact) => ({
        identifier: artifact.providerId ?? artifact.id,
        ...(artifact.url ? { url: artifact.url } : {}),
        ...(artifact.provider ? { provider: artifact.provider } : {}),
      }))
      .filter((target) => target.identifier.trim().length > 0);
  }

  const identifier = task.execution.reviewProviderId ?? task.execution.reviewId;
  if (!identifier) return [];
  return [{
    identifier,
    ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
  }];
}

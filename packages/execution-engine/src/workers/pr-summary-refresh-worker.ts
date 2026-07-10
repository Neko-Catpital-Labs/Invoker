import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
} from '@invoker/data-store';
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
export const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 60_000;

type PrSummaryRefreshActionStatus = WorkerActionStatus;

export interface PrSummaryRefreshWorkflow {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflow>;
  loadTasks(workflowId: string): TaskState[];
  loadTask?(taskId: string): TaskState | undefined;
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  intervalMs?: number;
  cwd?: string;
  mergeGateProvider?: MergeGateProvider;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshStore;
  instanceId?: string;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

export interface PrSummaryRefreshTickOptions extends PrSummaryRefreshWorkerConfig {
  logger: Logger;
  store: PrSummaryRefreshStore;
}

interface ReviewArtifactRef {
  identifier: string;
  url?: string;
  provider?: string;
}

type PrBodyRefreshProvider = MergeGateProvider & {
  getReviewBody(opts: { identifier: string; cwd: string }): Promise<string>;
  updateReviewBody(opts: { identifier: string; cwd: string; body: string }): Promise<void>;
};

export interface PrSummaryRefreshResult {
  scanned: number;
  updated: number;
  unchanged: number;
  failed: number;
  skipped: number;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review-gate PR bodies with the canonical Invoker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        ...deps.prSummaryRefresh,
      }),
  });
  return registry;
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshTickOptions): WorkerTick {
  return async (ctx) => {
    await refreshPrSummaries(options, ctx.signal);
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
    onTick: options.onTick ?? createPrSummaryRefreshTick({
      logger: options.logger,
      store: options.store,
      cwd: options.cwd,
      mergeGateProvider: options.mergeGateProvider ?? new GitHubMergeGateProvider(),
    }),
  });
}

export async function refreshPrSummaries(
  options: PrSummaryRefreshTickOptions,
  signal?: AbortSignal,
): Promise<PrSummaryRefreshResult> {
  const result: PrSummaryRefreshResult = {
    scanned: 0,
    updated: 0,
    unchanged: 0,
    failed: 0,
    skipped: 0,
  };
  const provider = options.mergeGateProvider ?? new GitHubMergeGateProvider();
  if (!provider.getReviewBody || !provider.updateReviewBody) {
    options.logger.debug?.('[worker:pr-summary-refresh] review provider does not support PR body refresh', {
      module: 'pr-summary-refresh-worker',
      provider: provider.name,
    });
    return result;
  }

  for (const workflow of options.store.listWorkflows()) {
    if (signal?.aborted) break;
    const tasks = options.store.loadTasks(workflow.id);
    for (const mergeTask of tasks.filter(isRefreshableMergeTask)) {
      if (signal?.aborted) break;
      const artifacts = currentReviewArtifacts(mergeTask);
      if (artifacts.length === 0) {
        result.skipped += 1;
        continue;
      }
      const workerActions = listWorkerActionsForWorkflow(options.store, workflow.id);
      for (const artifact of artifacts) {
        if (signal?.aborted) break;
        result.scanned += 1;
        try {
          const bodyRefreshProvider = provider as PrBodyRefreshProvider;
          const outcome = await refreshReviewArtifact({
            options,
            provider: bodyRefreshProvider,
            workflow,
            mergeTask,
            tasks,
            workerActions,
            artifact,
          });
          if (outcome === 'updated') result.updated += 1;
          else result.unchanged += 1;
        } catch (err) {
          result.failed += 1;
          recordPrSummaryRefreshAction(options, {
            workflow,
            mergeTask,
            artifact,
            bodyHash: 'unavailable',
            status: 'failed',
            summary: `Failed to refresh PR summary: ${errorMessage(err)}`,
            reason: 'refresh-failed',
            payload: { error: errorMessage(err) },
          });
          options.logger.warn?.('[worker:pr-summary-refresh] failed to refresh PR summary', {
            module: 'pr-summary-refresh-worker',
            workflowId: workflow.id,
            taskId: mergeTask.id,
            reviewId: artifact.identifier,
            err,
          });
        }
      }
    }
  }
  return result;
}

async function refreshReviewArtifact(args: {
  options: PrSummaryRefreshTickOptions;
  provider: PrBodyRefreshProvider;
  workflow: PrSummaryRefreshWorkflow;
  mergeTask: TaskState;
  tasks: readonly TaskState[];
  workerActions: readonly PrAuthoringWorkerActionEntry[];
  artifact: ReviewArtifactRef;
}): Promise<'updated' | 'unchanged'> {
  const cwd = args.mergeTask.execution.workspacePath ?? args.options.cwd ?? process.cwd();
  const currentBody = await args.provider.getReviewBody({
    identifier: args.artifact.identifier,
    cwd,
  });
  const context = buildPrSummaryAuthoringContext({
    workflow: args.workflow,
    tasks: args.tasks,
    workerActions: args.workerActions,
    visualProofMarkdown: extractVisualProofMarkdown(currentBody),
  });
  const body = buildCanonicalPrBody({
    title: args.workflow.name ?? 'Workflow',
    workflowSummary: args.mergeTask.config.summary ?? args.workflow.description ?? args.workflow.name ?? args.workflow.id,
    structuredContext: context,
  });
  const bodyHash = sha256(body);
  if (sameBody(currentBody, body)) {
    recordPrSummaryRefreshAction(args.options, {
      workflow: args.workflow,
      mergeTask: args.mergeTask,
      artifact: args.artifact,
      bodyHash,
      status: 'skipped',
      summary: 'PR summary already up to date',
      reason: 'unchanged',
    });
    return 'unchanged';
  }

  recordPrSummaryRefreshAction(args.options, {
    workflow: args.workflow,
    mergeTask: args.mergeTask,
    artifact: args.artifact,
    bodyHash,
    status: 'running',
    summary: 'Refreshing PR summary body',
  });
  await args.provider.updateReviewBody({
    identifier: args.artifact.identifier,
    cwd,
    body,
  });
  recordPrSummaryRefreshAction(args.options, {
    workflow: args.workflow,
    mergeTask: args.mergeTask,
    artifact: args.artifact,
    bodyHash,
    status: 'completed',
    summary: 'Refreshed PR summary body',
  });
  return 'updated';
}

function isRefreshableMergeTask(task: TaskState): boolean {
  if (!task.config.isMergeNode) return false;
  if (task.status !== 'review_ready' && task.status !== 'awaiting_approval') return false;
  return Boolean(task.execution.reviewGate || task.execution.reviewId);
}

function currentReviewArtifacts(task: TaskState): ReviewArtifactRef[] {
  const gate = task.execution.reviewGate;
  if (gate) {
    return gate.artifacts
      .filter((artifact) =>
        artifact.generation === gate.activeGeneration
        && artifact.status !== 'discarded'
        && artifact.status !== 'closed'
        && artifact.status !== 'merged'
        && !artifact.discardedAt)
      .map((artifact) => ({
        identifier: artifact.providerId ?? parsePullRequestNumber(artifact.url) ?? '',
        ...(artifact.url !== undefined ? { url: artifact.url } : {}),
        ...(artifact.provider !== undefined ? { provider: artifact.provider } : {}),
      }))
      .filter((artifact) => artifact.identifier.length > 0);
  }
  const identifier = task.execution.reviewId ?? parsePullRequestNumber(task.execution.reviewUrl);
  return identifier ? [{ identifier, ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}) }] : [];
}

function buildPrSummaryAuthoringContext(args: {
  workflow: PrSummaryRefreshWorkflow;
  tasks: readonly TaskState[];
  workerActions: readonly PrAuthoringWorkerActionEntry[];
  visualProofMarkdown?: string;
}): PrAuthoringContext {
  const taskEntries: PrAuthoringTaskEntry[] = args.tasks
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      ...(task.config.command ? { command: task.config.command } : {}),
    }));
  return {
    workflowName: args.workflow.name,
    workflowDescription: args.workflow.description,
    tasks: taskEntries,
    workerActions: [...args.workerActions],
    ...(args.visualProofMarkdown ? { visualProofMarkdown: args.visualProofMarkdown } : {}),
  };
}

function listWorkerActionsForWorkflow(
  store: PrSummaryRefreshStore,
  workflowId: string,
): PrAuthoringWorkerActionEntry[] {
  const actions = (store.listWorkerActions?.({ workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND);
  return actions.map((action) => {
    const payload = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
      ? action.payload as Record<string, unknown>
      : undefined;
    const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
    return {
      workerKind: action.workerKind,
      actionType: action.actionType,
      status: action.status,
      subjectType: action.subjectType,
      subjectId: action.subjectId,
      externalKey: action.externalKey,
      ...(action.workflowId !== undefined ? { workflowId: action.workflowId } : {}),
      ...(action.taskId !== undefined ? { taskId: action.taskId } : {}),
      ...(action.summary !== undefined ? { summary: action.summary } : {}),
      ...(reason !== undefined ? { reason } : {}),
      createdAt: action.createdAt,
      updatedAt: action.updatedAt,
      ...(action.completedAt !== undefined ? { completedAt: action.completedAt } : {}),
    };
  });
}

function recordPrSummaryRefreshAction(
  options: PrSummaryRefreshTickOptions,
  args: {
    workflow: PrSummaryRefreshWorkflow;
    mergeTask: TaskState;
    artifact: ReviewArtifactRef;
    bodyHash: string;
    status: PrSummaryRefreshActionStatus;
    summary: string;
    reason?: string;
    payload?: Record<string, unknown>;
  },
): void {
  const externalKey = [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    args.workflow.id,
    args.mergeTask.id,
    args.artifact.provider ?? 'review',
    args.artifact.identifier,
    args.bodyHash,
  ].join(':');
  const record = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey,
    subjectType: 'review',
    subjectId: args.artifact.identifier,
    workflowId: args.workflow.id,
    taskId: args.mergeTask.id,
    status: args.status,
    summary: args.summary,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
    incrementAttempt: args.status === 'running' || args.status === 'failed',
    payload: {
      reviewId: args.artifact.identifier,
      reviewUrl: args.artifact.url ?? null,
      bodyHash: args.bodyHash,
      ...(args.payload ?? {}),
    },
  });
  options.store.logEvent?.(args.mergeTask.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    actionId: record?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${externalKey}`,
    workflowId: args.workflow.id,
    reviewId: args.artifact.identifier,
    reviewUrl: args.artifact.url ?? null,
    status: args.status,
    summary: args.summary,
    ...(args.reason !== undefined ? { reason: args.reason } : {}),
  });
}

function sameBody(currentBody: string, nextBody: string): boolean {
  return currentBody.trimEnd() === nextBody.trimEnd();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function parsePullRequestNumber(url: string | undefined): string | undefined {
  const match = url?.match(/\/pull\/(\d+)(?:$|[/?#])/);
  return match?.[1];
}

function extractVisualProofMarkdown(body: string): string | undefined {
  const lines = body.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim().toLowerCase() === '## visual proof');
  if (start === -1) return undefined;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {0,3}##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return lines.slice(start, end).join('\n').trimEnd();
}

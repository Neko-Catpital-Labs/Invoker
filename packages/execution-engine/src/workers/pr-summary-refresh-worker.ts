import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionListFilters, WorkerActionRecord, WorkerActionStatus } from '@invoker/data-store';
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

const REFRESH_ACTION_TYPE = 'refresh-pr-summary';

export type PrSummaryRefreshProvider = Pick<
  MergeGateProvider,
  'name' | 'getReviewBody' | 'updateReviewBody'
>;

export interface PrSummaryRefreshWorkflow {
  id: string;
  name?: string;
  description?: string;
  status?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<PrSummaryRefreshWorkflow>;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?: Parameters<typeof recordWorkerDecisionRow>[0]['upsertWorkerAction'];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerConfig {
  provider?: PrSummaryRefreshProvider;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  provider?: PrSummaryRefreshProvider;
  logger: Logger;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  prSummaryRefresh?: PrSummaryRefreshWorkerPolicyOptions;
  onTick?: WorkerTick;
}

interface RefreshCandidate {
  workflow: PrSummaryRefreshWorkflow;
  tasks: TaskState[];
  mergeTask: TaskState;
  artifact: NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number];
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the canonical pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        intervalMs: deps.prSummaryRefresh?.intervalMs,
        prSummaryRefresh: {
          store: deps.store,
          provider: deps.prSummaryRefresh?.provider,
          logger: deps.logger,
        },
      }),
  });
  return registry;
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.provider?.getReviewBody || !options.provider.updateReviewBody) {
      options.logger.debug?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] review body provider unavailable`, {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const candidate of collectRefreshCandidates(options.store)) {
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
        ? createPrSummaryRefreshTick(options.prSummaryRefresh)
        : async () => {}
    ),
  });
}

export function buildPrSummaryRefreshBody(args: {
  workflow: PrSummaryRefreshWorkflow;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
  mergeTask?: TaskState;
}): string {
  const structuredContext: PrAuthoringContext = {
    workflowName: args.workflow.name,
    workflowDescription: args.workflow.description,
    tasks: args.tasks
      .filter((task) => !task.config.isMergeNode)
      .map(toPrAuthoringTaskEntry),
    workerActions: args.workerActions
      .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
      .map(toPrAuthoringWorkerActionEntry),
  };
  const fallbackSummary =
    args.workflow.description
    ?? args.mergeTask?.config.summary
    ?? args.workflow.name
    ?? `Workflow ${args.workflow.id}`;
  return buildCanonicalPrBody({
    title: args.workflow.name ?? args.mergeTask?.description ?? 'Workflow',
    workflowSummary: fallbackSummary,
    structuredContext,
  });
}

function collectRefreshCandidates(store: PrSummaryRefreshWorkerStore): RefreshCandidate[] {
  const candidates: RefreshCandidate[] = [];
  for (const workflow of store.listWorkflows()) {
    const tasks = store.loadTasks(workflow.id);
    for (const mergeTask of tasks) {
      if (!mergeTask.config.isMergeNode) continue;
      const gate = mergeTask.execution.reviewGate;
      if (!gate) continue;
      for (const artifact of gate.artifacts) {
        if (artifact.generation !== gate.activeGeneration) continue;
        if (artifact.discardedAt || artifact.status === 'discarded') continue;
        if (artifact.status === 'closed' || artifact.status === 'merged') continue;
        if (!artifact.providerId) continue;
        candidates.push({ workflow, tasks, mergeTask, artifact });
      }
    }
  }
  return candidates;
}

async function refreshCandidate(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: RefreshCandidate,
): Promise<void> {
  const identifier = candidate.artifact.providerId;
  if (!identifier) return;
  const cwd = candidate.mergeTask.execution.workspacePath ?? process.cwd();
  const externalKey = prSummaryRefreshActionKey(candidate);
  const workerActions = options.store.listWorkerActions?.({ workflowId: candidate.workflow.id }) ?? [];
  const desiredBody = buildPrSummaryRefreshBody({
    workflow: candidate.workflow,
    tasks: candidate.tasks,
    workerActions,
    mergeTask: candidate.mergeTask,
  });
  const bodyHash = hashBody(desiredBody);

  try {
    const currentBody = await options.provider!.getReviewBody!({ identifier, cwd });
    if (currentBody.trimEnd() === desiredBody.trimEnd()) {
      recordRefreshAction(options, candidate, 'skipped', 'PR summary already current', {
        externalKey,
        bodyHash,
        reason: 'content-current',
      });
      return;
    }

    await options.provider!.updateReviewBody!({ identifier, cwd, body: desiredBody });
    recordRefreshAction(options, candidate, 'completed', 'Updated PR summary body', {
      externalKey,
      bodyHash,
      previousBodyHash: hashBody(currentBody),
    });
  } catch (err) {
    recordRefreshAction(options, candidate, 'failed', 'Failed to refresh PR summary body', {
      externalKey,
      bodyHash,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function toPrAuthoringTaskEntry(task: TaskState): PrAuthoringTaskEntry {
  const status: PrAuthoringTaskEntry['status'] =
    task.status === 'completed' ? 'completed'
      : task.status === 'failed' ? 'failed'
        : 'skipped';
  return {
    taskId: task.id,
    description: task.description,
    status,
    ...(task.config.command ? { command: task.config.command } : {}),
  };
}

function toPrAuthoringWorkerActionEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = action.payload && typeof action.payload === 'object' && !Array.isArray(action.payload)
    ? (action.payload as Record<string, unknown>).reason
    : undefined;
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
    ...(typeof reason === 'string' ? { reason } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

function prSummaryRefreshActionKey(candidate: RefreshCandidate): string {
  return [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    candidate.mergeTask.id,
    candidate.artifact.provider ?? 'review',
    candidate.artifact.providerId ?? candidate.artifact.id,
    `g${candidate.artifact.generation}`,
  ].join(':');
}

function hashBody(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function recordRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: RefreshCandidate,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown> & { externalKey: string },
): void {
  const now = new Date().toISOString();
  const record = recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: REFRESH_ACTION_TYPE,
    externalKey: payload.externalKey,
    subjectType: 'review',
    subjectId: candidate.artifact.providerId ?? candidate.artifact.id,
    workflowId: candidate.workflow.id,
    taskId: candidate.mergeTask.id,
    status,
    summary,
    incrementAttempt: status === 'completed' || status === 'failed',
    now,
    payload: {
      provider: candidate.artifact.provider ?? options.provider?.name ?? null,
      reviewId: candidate.artifact.providerId ?? null,
      reviewUrl: candidate.artifact.url ?? null,
      generation: candidate.artifact.generation,
      ...payload,
    },
  });

  options.store.logEvent?.(candidate.mergeTask.id, 'task.worker_action', {
    level: status === 'failed' ? 'warn' : 'info',
    message: summary,
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: REFRESH_ACTION_TYPE,
    status,
    actionId: record?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${payload.externalKey}`,
    workflowId: candidate.workflow.id,
    reviewId: candidate.artifact.providerId ?? null,
    reviewUrl: candidate.artifact.url ?? null,
    summary,
    ...(typeof payload.reason === 'string' ? { reason: payload.reason } : {}),
  });
}

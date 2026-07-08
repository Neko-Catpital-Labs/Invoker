import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import type { MergeGateProvider } from '../merge-gate-provider.js';
import {
  buildCanonicalPrBody,
  type PrAuthoringContext,
  type PrAuthoringTaskEntry,
  type PrAuthoringWorkerActionEntry,
} from '../pr-authoring.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';
import type { WorkerRegistry } from '../worker-registry.js';
import type { WorkerStateStore } from '../worker-types.js';

export const PR_SUMMARY_REFRESH_WORKER_KIND = 'pr-summary-refresh';
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: WorkerStateStore;
  mergeGateProvider: MergeGateProvider;
  logger: Logger;
  cwd?: string;
}

export interface PrSummaryRefreshWorkerOptions {
  logger: Logger;
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  prSummary?: Omit<PrSummaryRefreshWorkerPolicyOptions, 'logger'>;
  onTick?: WorkerTick;
}

interface RefreshArtifact {
  providerId: string;
  url?: string;
  id?: string;
}

export function prSummaryRefreshActionKey(args: {
  workflowId: string;
  taskId: string;
  providerId: string;
  bodyHash: string;
}): string {
  return [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    args.workflowId,
    args.taskId,
    `pr-${args.providerId}`,
    args.bodyHash.slice(0, 16),
  ].join(':');
}

function actionIdForKey(externalKey: string): string {
  return `${PR_SUMMARY_REFRESH_WORKER_KIND}:${externalKey}`;
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body).digest('hex');
}

function normalizeBody(body: string): string {
  return body.replace(/\r\n/g, '\n').trimEnd();
}

function taskEntry(task: TaskState): PrAuthoringTaskEntry {
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

function workerActionEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  return {
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectType: action.subjectType,
    subjectId: action.subjectId,
    attemptCount: action.attemptCount,
    ...(action.summary ? { summary: action.summary } : {}),
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  };
}

export function buildPrSummaryRefreshBody(args: {
  workflow: Workflow | undefined;
  mergeTask: TaskState;
  workflowTasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
}): string {
  const structuredContext: PrAuthoringContext = {
    workflowName: args.workflow?.name,
    workflowDescription: args.workflow?.description,
    tasks: args.workflowTasks
      .filter((task) => !task.config.isMergeNode)
      .map(taskEntry),
    workerActions: args.workerActions
      .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
      .map(workerActionEntry),
  };
  const workflowSummary =
    args.mergeTask.config.summary
    ?? args.workflow?.description
    ?? args.workflow?.name
    ?? args.mergeTask.description;
  return buildCanonicalPrBody({
    title: args.workflow?.name ?? args.mergeTask.description,
    workflowSummary,
    structuredContext,
  });
}

function currentReviewArtifacts(task: TaskState): RefreshArtifact[] {
  const gate = task.execution.reviewGate;
  if (!gate) {
    return task.execution.reviewId
      ? [{
          providerId: task.execution.reviewId,
          ...(task.execution.reviewUrl ? { url: task.execution.reviewUrl } : {}),
        }]
      : [];
  }

  return gate.artifacts
    .filter((artifact: ReviewGateArtifact) =>
      artifact.providerId
      && artifact.status !== 'discarded'
      && !artifact.discardedAt
      && artifact.generation === gate.activeGeneration,
    )
    .map((artifact) => ({
      providerId: artifact.providerId!,
      ...(artifact.url ? { url: artifact.url } : {}),
      ...(artifact.id ? { id: artifact.id } : {}),
    }));
}

function getExistingAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  externalKey: string,
): WorkerActionRecord | undefined {
  return options.store.getWorkerAction(PR_SUMMARY_REFRESH_WORKER_KIND, externalKey);
}

function logWorkerAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  action: WorkerActionRecord | WorkerActionWrite,
  phase: string,
): void {
  const taskId = action.taskId;
  if (!taskId) return;
  options.store.logEvent?.(taskId, 'task.worker_action', {
    phase,
    worker: PR_SUMMARY_REFRESH_WORKER_KIND,
    workerKind: action.workerKind,
    actionType: action.actionType,
    externalKey: action.externalKey,
    status: action.status,
    attemptCount: action.attemptCount ?? 0,
    summary: action.summary ?? null,
    payload: action.payload ?? null,
  });
}

function recordPrSummaryAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  args: {
    externalKey: string;
    status: WorkerActionStatus;
    workflowId: string;
    taskId: string;
    providerId: string;
    summary: string;
    payload?: Record<string, unknown>;
    consumeAttempt?: boolean;
  },
): WorkerActionRecord {
  const existing = getExistingAction(options, args.externalKey);
  const now = new Date().toISOString();
  const attemptCount = args.consumeAttempt
    ? (existing?.attemptCount ?? 0) + 1
    : existing?.attemptCount ?? 0;
  const write: WorkerActionWrite = {
    id: existing?.id ?? actionIdForKey(args.externalKey),
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: args.workflowId,
    taskId: args.taskId,
    subjectType: 'pull_request',
    subjectId: args.providerId,
    externalKey: args.externalKey,
    status: args.status,
    attemptCount,
    summary: args.summary,
    payload: args.payload ?? {},
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped'
      ? { completedAt: now }
      : {}),
  };
  const saved = options.store.upsertWorkerAction(write);
  logWorkerAction(options, saved, `pr-summary-refresh-${args.status}`);
  return saved;
}

async function refreshArtifact(
  options: PrSummaryRefreshWorkerPolicyOptions,
  args: {
    workflowId: string;
    taskId: string;
    artifact: RefreshArtifact;
    body: string;
    cwd: string;
  },
): Promise<void> {
  const getReviewBody = options.mergeGateProvider.getReviewBody;
  const updateReviewBody = options.mergeGateProvider.updateReviewBody;
  if (!getReviewBody || !updateReviewBody) return;

  const hash = bodyHash(args.body);
  const externalKey = prSummaryRefreshActionKey({
    workflowId: args.workflowId,
    taskId: args.taskId,
    providerId: args.artifact.providerId,
    bodyHash: hash,
  });

  let currentBody: string;
  try {
    currentBody = await getReviewBody.call(options.mergeGateProvider, {
      identifier: args.artifact.providerId,
      cwd: args.cwd,
    });
  } catch (err) {
    recordPrSummaryAction(options, {
      externalKey,
      status: 'failed',
      workflowId: args.workflowId,
      taskId: args.taskId,
      providerId: args.artifact.providerId,
      summary: 'Failed to read PR body before refreshing pipeline summary',
      payload: {
        reason: 'read-review-body-failed',
        bodyHash: hash,
        reviewUrl: args.artifact.url ?? null,
        error: err instanceof Error ? err.message : String(err),
      },
      consumeAttempt: true,
    });
    return;
  }

  if (normalizeBody(currentBody) === normalizeBody(args.body)) {
    recordPrSummaryAction(options, {
      externalKey,
      status: 'skipped',
      workflowId: args.workflowId,
      taskId: args.taskId,
      providerId: args.artifact.providerId,
      summary: 'Skipped PR summary refresh because the body is already current',
      payload: {
        reason: 'body-current',
        bodyHash: hash,
        reviewUrl: args.artifact.url ?? null,
      },
    });
    return;
  }

  try {
    await updateReviewBody.call(options.mergeGateProvider, {
      identifier: args.artifact.providerId,
      cwd: args.cwd,
      body: args.body,
    });
  } catch (err) {
    recordPrSummaryAction(options, {
      externalKey,
      status: 'failed',
      workflowId: args.workflowId,
      taskId: args.taskId,
      providerId: args.artifact.providerId,
      summary: 'Failed to update PR pipeline summary',
      payload: {
        reason: 'update-review-body-failed',
        bodyHash: hash,
        reviewUrl: args.artifact.url ?? null,
        error: err instanceof Error ? err.message : String(err),
      },
      consumeAttempt: true,
    });
    return;
  }

  recordPrSummaryAction(options, {
    externalKey,
    status: 'completed',
    workflowId: args.workflowId,
    taskId: args.taskId,
    providerId: args.artifact.providerId,
    summary: 'Updated PR body with the latest Invoker pipeline summary',
    payload: {
      bodyHash: hash,
      reviewUrl: args.artifact.url ?? null,
    },
    consumeAttempt: true,
  });
}

async function refreshMergeTask(
  options: PrSummaryRefreshWorkerPolicyOptions,
  workflow: Workflow | undefined,
  workflowTasks: readonly TaskState[],
  mergeTask: TaskState,
): Promise<void> {
  const workflowId = mergeTask.config.workflowId;
  if (!workflowId) return;
  const artifacts = currentReviewArtifacts(mergeTask);
  if (artifacts.length === 0) return;

  const workerActions = options.store.listWorkerActions({ workflowId });
  const body = buildPrSummaryRefreshBody({
    workflow,
    mergeTask,
    workflowTasks,
    workerActions,
  });
  const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();

  for (const artifact of artifacts) {
    await refreshArtifact(options, {
      workflowId,
      taskId: mergeTask.id,
      artifact,
      body,
      cwd,
    });
  }
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    if (!options.mergeGateProvider.getReviewBody || !options.mergeGateProvider.updateReviewBody) {
      options.logger.debug?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] review body update unavailable`, {
        module: 'pr-summary-refresh-worker',
      });
      return;
    }

    for (const workflowRef of options.store.listWorkflows()) {
      const workflow = options.store.loadWorkflow?.(workflowRef.id);
      const workflowTasks = options.store.loadTasks(workflowRef.id);
      for (const task of workflowTasks.filter((candidate) => candidate.config.isMergeNode)) {
        await refreshMergeTask(options, workflow, workflowTasks, task);
      }
    }
  };
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  const onTick = options.onTick ?? (
    options.prSummary
      ? createPrSummaryRefreshTick({ ...options.prSummary, logger: options.logger })
      : (() => {})
  );
  return createWorkerRuntime({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick,
  });
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes Invoker PR bodies with the latest worker pipeline summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummary: deps.mergeGateProvider
          ? {
              store: deps.store,
              mergeGateProvider: deps.mergeGateProvider,
              cwd: deps.cwd,
            }
          : undefined,
      }),
  });
  return registry;
}

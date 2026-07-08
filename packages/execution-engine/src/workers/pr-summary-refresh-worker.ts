import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionStatus, WorkerActionWrite, Workflow } from '@invoker/data-store';
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
export const DEFAULT_PR_SUMMARY_REFRESH_WORKER_INTERVAL_MS = 5 * 60_000;

const PR_SUMMARY_REFRESH_ACTION_TYPE = 'refresh-pr-summary';
const DEFAULT_REVIEW_PROVIDER = 'github';
const MAX_PIPELINE_WORKER_ACTIONS = 50;

type ReviewGateArtifact = NonNullable<TaskState['execution']['reviewGate']>['artifacts'][number];

export interface PrSummaryRefreshWorkerConfig {
  /** CWD used for provider CLI calls when the merge task has no persisted workspace. */
  cwd?: string;
  intervalMs?: number;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<{ id: string }>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord;
  listWorkerActions(filters?: { workflowId?: string; workerKind?: string; limit?: number }): WorkerActionRecord[];
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshReviewProviderRegistry {
  get(name: string): MergeGateProvider | undefined;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  reviewProviders?: PrSummaryRefreshReviewProviderRegistry;
  cwd?: string;
}

export interface PrSummaryRefreshWorkerOptions extends PrSummaryRefreshWorkerPolicyOptions {
  instanceId?: string;
  intervalMs?: number;
  installSignalHandlers?: boolean;
  tickOnStart?: boolean;
  onTick?: WorkerTick;
}

interface ReviewTarget {
  workflowId: string;
  workflow?: Workflow;
  mergeTask: TaskState;
  artifact: Pick<ReviewGateArtifact, 'id' | 'title' | 'url' | 'providerId' | 'provider' | 'generation'>;
  providerName: string;
  identifier: string;
  cwd: string;
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with canonical Invoker pipeline summaries.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        store: deps.store,
        reviewProviders: deps.reviewProviders,
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
    onTick: options.onTick ?? createPrSummaryRefreshTick(options),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    const targets = listPrSummaryRefreshTargets(options);
    for (const target of targets) {
      await refreshPrSummaryTarget(options, target);
    }
  };
}

export function listPrSummaryRefreshTargets(options: PrSummaryRefreshWorkerPolicyOptions): ReviewTarget[] {
  const targets: ReviewTarget[] = [];
  for (const workflowRef of options.store.listWorkflows()) {
    const workflow = options.store.loadWorkflow?.(workflowRef.id);
    const tasks = options.store.loadTasks(workflowRef.id);
    for (const mergeTask of tasks) {
      if (!mergeTask.config.isMergeNode) continue;
      for (const artifact of currentReviewArtifacts(mergeTask)) {
        if (!artifact.providerId) continue;
        const providerName = artifact.provider ?? workflow?.reviewProvider ?? DEFAULT_REVIEW_PROVIDER;
        const cwd = mergeTask.execution.workspacePath ?? options.cwd;
        if (!cwd) continue;
        targets.push({
          workflowId: workflowRef.id,
          workflow,
          mergeTask,
          artifact,
          providerName,
          identifier: artifact.providerId,
          cwd,
        });
      }
    }
  }
  return targets;
}

async function refreshPrSummaryTarget(
  options: PrSummaryRefreshWorkerPolicyOptions,
  target: ReviewTarget,
): Promise<void> {
  const provider = options.reviewProviders?.get(target.providerName);
  const basePayload = reviewTargetPayload(target);
  const externalKey = actionExternalKey(target);
  const existing = options.store.getWorkerAction(PR_SUMMARY_REFRESH_WORKER_KIND, externalKey);
  const now = new Date().toISOString();
  const action = buildActionWrite(target, existing, now, 'completed', 'PR summary refresh checked', {
    ...basePayload,
    changed: false,
  });

  if (!provider?.getReviewBody || !provider.updateReviewBody) {
    recordActionAndEvent(options, target, {
      ...action,
      status: 'skipped',
      summary: `Skipped PR summary refresh: provider "${target.providerName}" cannot read and update review bodies`,
      payload: {
        ...basePayload,
        reason: 'provider-body-update-unavailable',
      },
      completedAt: now,
    });
    return;
  }

  try {
    const nextBody = renderPrSummaryBody(options, target, action);
    const currentBody = await provider.getReviewBody({ identifier: target.identifier, cwd: target.cwd });
    const changed = currentBody.trimEnd() !== nextBody.trimEnd();
    if (changed) {
      await provider.updateReviewBody({ identifier: target.identifier, cwd: target.cwd, body: nextBody });
    }
    recordActionAndEvent(options, target, {
      ...action,
      payload: {
        ...basePayload,
        changed,
        bodySha256: sha256(nextBody),
      },
      completedAt: now,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordActionAndEvent(options, target, {
      ...action,
      status: 'failed',
      summary: `PR summary refresh failed: ${firstLine(message)}`,
      payload: {
        ...basePayload,
        error: message,
      },
      completedAt: now,
    });
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR summary`, {
      module: 'pr-summary-refresh-worker',
      workflowId: target.workflowId,
      taskId: target.mergeTask.id,
      provider: target.providerName,
      reviewId: target.identifier,
      err,
    });
  }
}

function currentReviewArtifacts(task: TaskState): ReviewTarget['artifact'][] {
  const gate = task.execution.reviewGate;
  if (!gate) {
    if (!task.execution.reviewId) return [];
    return [{
      id: task.execution.reviewId,
      providerId: task.execution.reviewId,
      url: task.execution.reviewUrl,
      provider: DEFAULT_REVIEW_PROVIDER,
      generation: task.execution.generation ?? 0,
    }];
  }
  return gate.artifacts.filter((artifact) =>
    artifact.generation === gate.activeGeneration
    && artifact.status !== 'discarded'
    && !artifact.discardedAt
    && !!artifact.providerId,
  );
}

function renderPrSummaryBody(
  options: PrSummaryRefreshWorkerPolicyOptions,
  target: ReviewTarget,
  candidateAction: WorkerActionWrite,
): string {
  const context = buildPrAuthoringContextFromStore(options, target, candidateAction);
  return buildCanonicalPrBody({
    title: target.workflow?.name ?? target.mergeTask.description,
    workflowSummary: target.mergeTask.config.summary ?? target.workflow?.description ?? `Invoker workflow ${target.workflowId}`,
    structuredContext: context,
  });
}

function buildPrAuthoringContextFromStore(
  options: PrSummaryRefreshWorkerPolicyOptions,
  target: ReviewTarget,
  candidateAction: WorkerActionWrite,
): PrAuthoringContext {
  const tasks = options.store.loadTasks(target.workflowId);
  const entries: PrAuthoringTaskEntry[] = tasks
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      ...(task.config.command ? { command: task.config.command } : {}),
    }));

  return {
    workflowName: target.workflow?.name,
    workflowDescription: target.workflow?.description,
    tasks: entries,
    workerActions: workerActionsForPipeline(options, target.workflowId, candidateAction),
  };
}

function workerActionsForPipeline(
  options: PrSummaryRefreshWorkerPolicyOptions,
  workflowId: string,
  candidateAction: WorkerActionWrite,
): PrAuthoringWorkerActionEntry[] {
  const byKey = new Map<string, WorkerActionRecord | WorkerActionWrite>();
  for (const action of options.store.listWorkerActions({ workflowId, limit: MAX_PIPELINE_WORKER_ACTIONS })) {
    byKey.set(`${action.workerKind}:${action.externalKey}`, action);
  }
  byKey.set(`${candidateAction.workerKind}:${candidateAction.externalKey}`, candidateAction);
  return [...byKey.values()].map((action) => ({
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    ...(action.taskId ? { taskId: action.taskId } : {}),
    subjectId: action.subjectId,
    ...(action.summary ? { summary: action.summary } : {}),
    ...(action.createdAt ? { createdAt: action.createdAt } : {}),
    ...(action.updatedAt ? { updatedAt: action.updatedAt } : {}),
    ...(action.completedAt ? { completedAt: action.completedAt } : {}),
  }));
}

function buildActionWrite(
  target: ReviewTarget,
  existing: WorkerActionRecord | undefined,
  now: string,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): WorkerActionWrite {
  const externalKey = actionExternalKey(target);
  return {
    id: existing?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${externalKey}`,
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    workflowId: target.workflowId,
    taskId: target.mergeTask.id,
    subjectType: 'review',
    subjectId: target.identifier,
    externalKey,
    status,
    attemptCount: existing?.attemptCount ?? 1,
    summary,
    payload,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    completedAt: now,
  };
}

function recordActionAndEvent(
  options: PrSummaryRefreshWorkerPolicyOptions,
  target: ReviewTarget,
  action: WorkerActionWrite,
): void {
  const saved = options.store.upsertWorkerAction(action);
  const payload = action.payload && typeof action.payload === 'object'
    ? action.payload as Record<string, unknown>
    : {};
  const level = saved.status === 'failed' ? 'error' : saved.status === 'skipped' ? 'warn' : 'info';
  options.store.logEvent?.(target.mergeTask.id, 'task.worker_action', {
    level,
    message: saved.summary ?? `${saved.workerKind}/${saved.actionType} ${saved.status}`,
    workerKind: saved.workerKind,
    actionType: saved.actionType,
    status: saved.status,
    workflowId: target.workflowId,
    reviewId: target.identifier,
    reviewUrl: target.artifact.url ?? null,
    ...payload,
  });
}

function actionExternalKey(target: ReviewTarget): string {
  return [
    target.workflowId,
    target.mergeTask.id,
    target.providerName,
    target.identifier,
    `g${target.artifact.generation ?? target.mergeTask.execution.generation ?? 0}`,
  ].join(':');
}

function reviewTargetPayload(target: ReviewTarget): Record<string, unknown> {
  return {
    provider: target.providerName,
    reviewId: target.identifier,
    reviewUrl: target.artifact.url ?? null,
    artifactId: target.artifact.id,
    generation: target.artifact.generation ?? target.mergeTask.execution.generation ?? 0,
    workflowId: target.workflowId,
    taskId: target.mergeTask.id,
  };
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] || 'unknown error';
}

import { createHash } from 'node:crypto';

import type { Logger } from '@invoker/contracts';
import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
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

interface WorkflowRef {
  id: string;
  name?: string;
  description?: string;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<WorkflowRef>;
  loadWorkflow?(workflowId: string): Workflow | WorkflowRef | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshProvider {
  name: string;
  getReviewBody?(opts: { identifier: string; cwd: string }): Promise<string>;
  updateReviewBody?(opts: { identifier: string; cwd: string; body: string }): Promise<void>;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  mergeGateProvider?: PrSummaryRefreshProvider;
  cwd?: string;
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
  workflow: WorkflowRef;
  mergeTask: TaskState;
  providerId: string;
  providerName?: string;
  reviewUrl?: string;
  title?: string;
  generation: number;
  cwd: string;
}

/** Register the built-in PR summary refresh worker. */
export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the latest Invoker worker action pipeline.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          mergeGateProvider: deps.mergeGateProvider ?? new GitHubMergeGateProvider(),
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
    && artifact.status !== 'closed'
    && artifact.status !== 'merged'
    && !artifact.discardedAt;
}

function candidateExternalKey(candidate: PrSummaryRefreshCandidate): string {
  return [
    PR_SUMMARY_REFRESH_WORKER_KIND,
    candidate.workflowId,
    candidate.providerName ?? 'provider',
    candidate.providerId,
    `g${candidate.generation}`,
  ].join(':');
}

function bodyHash(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex');
}

function normalizeBodyForComparison(body: string): string {
  return body.trimEnd();
}

function workflowForCandidate(
  store: PrSummaryRefreshWorkerStore,
  workflow: WorkflowRef,
): WorkflowRef {
  return store.loadWorkflow?.(workflow.id) ?? workflow;
}

export function listPrSummaryRefreshCandidates(
  options: Pick<PrSummaryRefreshWorkerPolicyOptions, 'store' | 'cwd' | 'mergeGateProvider'>,
): PrSummaryRefreshCandidate[] {
  const candidates: PrSummaryRefreshCandidate[] = [];
  const providerName = options.mergeGateProvider?.name;
  for (const workflowRef of options.store.listWorkflows()) {
    const workflow = workflowForCandidate(options.store, workflowRef);
    const tasks = options.store.loadTasks(workflow.id);
    const mergeTask = tasks.find((task) =>
      task.config.workflowId === workflow.id
      && task.config.isMergeNode
      && (task.execution.reviewGate || task.execution.reviewId)
    );
    if (!mergeTask) continue;

    const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
    const gate = mergeTask.execution.reviewGate;
    if (gate) {
      for (const artifact of gate.artifacts) {
        if (!isCurrentReviewArtifact(gate, artifact)) continue;
        if (!artifact.providerId) continue;
        if (providerName && artifact.provider && artifact.provider !== providerName) continue;
        candidates.push({
          workflowId: workflow.id,
          workflow,
          mergeTask,
          providerId: artifact.providerId,
          providerName: artifact.provider ?? providerName,
          reviewUrl: artifact.url,
          title: artifact.title,
          generation: artifact.generation,
          cwd,
        });
      }
      continue;
    }

    if (mergeTask.execution.reviewId) {
      candidates.push({
        workflowId: workflow.id,
        workflow,
        mergeTask,
        providerId: mergeTask.execution.reviewId,
        providerName,
        reviewUrl: mergeTask.execution.reviewUrl,
        title: workflow.name,
        generation: mergeTask.execution.generation ?? 0,
        cwd,
      });
    }
  }
  return candidates;
}

function taskStatusForPr(task: TaskState): PrAuthoringTaskEntry['status'] {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'failed') return 'failed';
  return 'skipped';
}

function reasonFromPayload(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const reason = (payload as Record<string, unknown>).reason;
  return typeof reason === 'string' && reason.trim().length > 0 ? reason : undefined;
}

function workerActionToPrEntry(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  const reason = reasonFromPayload(action.payload);
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
  };
}

export function buildPrSummaryRefreshContext(
  options: Pick<PrSummaryRefreshWorkerPolicyOptions, 'store'>,
  candidate: Pick<PrSummaryRefreshCandidate, 'workflowId' | 'workflow'>,
): PrAuthoringContext {
  const tasks = options.store
    .loadTasks(candidate.workflowId)
    .filter((task) => !task.config.isMergeNode)
    .map((task): PrAuthoringTaskEntry => ({
      taskId: task.id,
      description: task.description,
      status: taskStatusForPr(task),
      ...(task.config.command ? { command: task.config.command } : {}),
    }));
  const workerActions = (options.store.listWorkerActions?.({ workflowId: candidate.workflowId }) ?? [])
    .filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND)
    .map(workerActionToPrEntry);

  return {
    workflowName: candidate.workflow.name,
    workflowDescription: candidate.workflow.description,
    tasks,
    workerActions,
  };
}

export function buildPrSummaryRefreshBody(
  options: Pick<PrSummaryRefreshWorkerPolicyOptions, 'store'>,
  candidate: PrSummaryRefreshCandidate,
): string {
  const context = buildPrSummaryRefreshContext(options, candidate);
  return buildCanonicalPrBody({
    title: candidate.title ?? candidate.workflow.name ?? candidate.workflowId,
    workflowSummary: candidate.workflow.description ?? candidate.workflow.name ?? candidate.workflowId,
    structuredContext: context,
  });
}

function recordPrSummaryAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): WorkerActionRecord | undefined {
  return recordWorkerDecisionRow(options.store, {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    externalKey: candidateExternalKey(candidate),
    subjectType: 'review',
    subjectId: candidate.providerId,
    workflowId: candidate.workflowId,
    taskId: candidate.mergeTask.id,
    status,
    summary,
    incrementAttempt: status === 'completed' || status === 'failed',
    payload: {
      reviewId: candidate.providerId,
      reviewUrl: candidate.reviewUrl ?? null,
      provider: candidate.providerName ?? null,
      generation: candidate.generation,
      ...payload,
    },
  });
}

function logWorkerActionEvent(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
  action: WorkerActionRecord | undefined,
  status: WorkerActionStatus,
  summary: string,
  payload: Record<string, unknown>,
): void {
  options.store.logEvent?.(candidate.mergeTask.id, 'task.worker_action', {
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: PR_SUMMARY_REFRESH_ACTION_TYPE,
    actionId: action?.id ?? null,
    status,
    summary,
    workflowId: candidate.workflowId,
    reviewId: candidate.providerId,
    reviewUrl: candidate.reviewUrl ?? null,
    ...payload,
  });
}

function canUpdateProvider(provider: PrSummaryRefreshProvider | undefined): provider is Required<
  Pick<PrSummaryRefreshProvider, 'getReviewBody' | 'updateReviewBody' | 'name'>
> {
  return Boolean(provider?.getReviewBody && provider.updateReviewBody);
}

async function refreshCandidate(
  options: PrSummaryRefreshWorkerPolicyOptions,
  candidate: PrSummaryRefreshCandidate,
): Promise<void> {
  const provider = options.mergeGateProvider;
  if (!canUpdateProvider(provider)) {
    const payload = { reason: 'provider-update-unavailable' };
    const action = recordPrSummaryAction(
      options,
      candidate,
      'skipped',
      'Skipped PR summary refresh: provider cannot read and update bodies',
      payload,
    );
    logWorkerActionEvent(options, candidate, action, 'skipped', 'Skipped PR summary refresh', payload);
    return;
  }

  const desiredBody = buildPrSummaryRefreshBody(options, candidate);
  const desiredHash = bodyHash(desiredBody);
  try {
    const liveBody = await provider.getReviewBody({ identifier: candidate.providerId, cwd: candidate.cwd });
    if (normalizeBodyForComparison(liveBody) === normalizeBodyForComparison(desiredBody)) {
      const payload = { reason: 'body-current', bodyHash: desiredHash, bodyChanged: false };
      const action = recordPrSummaryAction(options, candidate, 'skipped', 'PR summary already current', payload);
      logWorkerActionEvent(options, candidate, action, 'skipped', 'PR summary already current', payload);
      return;
    }

    await provider.updateReviewBody({ identifier: candidate.providerId, cwd: candidate.cwd, body: desiredBody });
    const payload = { bodyHash: desiredHash, bodyChanged: true, bodyLength: desiredBody.length };
    const action = recordPrSummaryAction(options, candidate, 'completed', 'Updated PR summary with worker pipeline', payload);
    logWorkerActionEvent(options, candidate, action, 'completed', 'Updated PR summary with worker pipeline', payload);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const payload = { reason: 'provider-error', error: message, bodyHash: desiredHash };
    const action = recordPrSummaryAction(options, candidate, 'failed', `Failed to refresh PR summary: ${message}`, payload);
    logWorkerActionEvent(options, candidate, action, 'failed', 'Failed to refresh PR summary', payload);
    options.logger.warn?.(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to refresh PR summary`, {
      module: 'pr-summary-refresh-worker',
      workflowId: candidate.workflowId,
      taskId: candidate.mergeTask.id,
      reviewId: candidate.providerId,
      err,
    });
  }
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    const seen = new Set<string>();
    for (const candidate of listPrSummaryRefreshCandidates(options)) {
      const key = candidateExternalKey(candidate);
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

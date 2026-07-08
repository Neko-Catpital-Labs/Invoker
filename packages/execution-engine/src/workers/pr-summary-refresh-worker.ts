import type {
  WorkerActionListFilters,
  WorkerActionRecord,
  WorkerActionStatus,
  WorkerActionWrite,
  Workflow,
} from '@invoker/data-store';
import type { Logger } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';

import { GitHubMergeGateProvider } from '../github-merge-gate-provider.js';
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
export const DEFAULT_PR_SUMMARY_REFRESH_INTERVAL_MS = 5 * 60_000;

const REFRESH_ACTION_TYPE = 'refresh-pr-summary';
const TASK_WORKER_ACTION_EVENT = 'task.worker_action';

type ReviewGateState = NonNullable<TaskState['execution']['reviewGate']>;
type ReviewGateArtifact = ReviewGateState['artifacts'][number];

export interface PrSummaryRefreshProvider {
  readonly name: string;
  getReviewBody(opts: { identifier: string; cwd: string }): Promise<string>;
  updateReviewBody(opts: { identifier: string; cwd: string; body: string }): Promise<void>;
}

export interface PrSummaryRefreshWorkerStore {
  listWorkflows(): ReadonlyArray<Pick<Workflow, 'id'> & Partial<Workflow>>;
  loadWorkflow?(workflowId: string): Workflow | undefined;
  loadTasks(workflowId: string): TaskState[];
  listWorkerActions?(filters?: WorkerActionListFilters): WorkerActionRecord[];
  getWorkerAction?(workerKind: string, externalKey: string): WorkerActionRecord | undefined;
  upsertWorkerAction?(action: WorkerActionWrite): WorkerActionRecord;
  logEvent?(taskId: string, eventType: string, payload?: unknown): void;
}

export interface PrSummaryRefreshWorkerPolicyOptions {
  store: PrSummaryRefreshWorkerStore;
  logger: Logger;
  provider?: PrSummaryRefreshProvider;
  cwd?: string;
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

interface RefreshTarget {
  identifier: string;
  url?: string;
  title?: string;
  provider?: string;
  baseBranch?: string;
  branch?: string;
  generation: number;
}

export function registerPrSummaryRefreshWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    note: 'Refreshes review PR bodies with the current Invoker pipeline worker-action summary.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const configured = deps.prMaintenance?.prSummaryRefresh;
      return createPrSummaryRefreshWorker({
        logger: deps.logger,
        prSummaryRefresh: {
          store: deps.store,
          cwd: configured?.cwd,
          provider: new GitHubMergeGateProvider(),
        },
        intervalMs: configured?.pollIntervalMs,
      });
    },
  });
  return registry;
}

export function prSummaryRefreshActionKey(
  workflowId: string,
  identifier: string,
  generation: number,
): string {
  return ['pr-summary-refresh', workflowId, identifier, generation].join(':');
}

export function createPrSummaryRefreshWorker(options: PrSummaryRefreshWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: PR_SUMMARY_REFRESH_WORKER_KIND,
    instanceId: options.instanceId,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_PR_SUMMARY_REFRESH_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? false,
    installSignalHandlers: options.installSignalHandlers,
    onTick: options.onTick ?? (
      options.prSummaryRefresh
        ? createPrSummaryRefreshTick({ ...options.prSummaryRefresh, logger: options.logger })
        : (() => {})
    ),
  });
}

export function createPrSummaryRefreshTick(options: PrSummaryRefreshWorkerPolicyOptions): WorkerTick {
  return async () => {
    const provider = options.provider ?? new GitHubMergeGateProvider();
    for (const listedWorkflow of options.store.listWorkflows()) {
      const workflow = options.store.loadWorkflow?.(listedWorkflow.id) ?? listedWorkflow;
      const tasks = options.store.loadTasks(workflow.id);
      for (const task of tasks.filter((candidate) => candidate.config.isMergeNode)) {
        const targets = collectRefreshTargets(task);
        for (const target of targets) {
          if (target.provider && target.provider !== provider.name) continue;
          await refreshReviewBodyForTarget({
            options,
            provider,
            workflow,
            tasks,
            mergeTask: task,
            target,
          });
        }
      }
    }
  };
}

export function buildPrSummaryRefreshBody(args: {
  workflow: Pick<Workflow, 'id'> & Partial<Workflow>;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
  title?: string;
}): string {
  const structuredContext = buildPrSummaryAuthoringContext({
    workflow: args.workflow,
    tasks: args.tasks,
    workerActions: args.workerActions,
  });
  return buildCanonicalPrBody({
    title: args.title ?? args.workflow.name ?? 'Workflow',
    workflowSummary: buildWorkflowSummary(args.workflow, args.tasks),
    structuredContext,
  });
}

function collectRefreshTargets(task: TaskState): RefreshTarget[] {
  const generation = task.execution.generation ?? 0;
  const gate = task.execution.reviewGate;
  if (gate?.artifacts && gate.artifacts.length > 0) {
    return gate.artifacts
      .filter((artifact) => isActiveReviewArtifact(gate, artifact))
      .map((artifact) => ({
        identifier: artifact.providerId ?? artifact.id,
        url: artifact.url,
        title: artifact.title,
        provider: artifact.provider,
        baseBranch: artifact.baseBranch,
        branch: artifact.branch,
        generation: artifact.generation ?? gate.activeGeneration ?? generation,
      }))
      .filter((target) => target.identifier.length > 0);
  }
  if (!task.execution.reviewId) return [];
  return [{
    identifier: task.execution.reviewId,
    url: task.execution.reviewUrl,
    title: task.description,
    branch: task.execution.branch,
    generation,
  }];
}

function isActiveReviewArtifact(gate: ReviewGateState, artifact: ReviewGateArtifact): boolean {
  if (artifact.discardedAt || artifact.status === 'discarded') return false;
  if (artifact.generation !== undefined && artifact.generation !== gate.activeGeneration) return false;
  return Boolean(artifact.providerId ?? artifact.id);
}

async function refreshReviewBodyForTarget(args: {
  options: PrSummaryRefreshWorkerPolicyOptions;
  provider: PrSummaryRefreshProvider;
  workflow: Pick<Workflow, 'id'> & Partial<Workflow>;
  tasks: readonly TaskState[];
  mergeTask: TaskState;
  target: RefreshTarget;
}): Promise<void> {
  const { options, provider, workflow, tasks, mergeTask, target } = args;
  const externalKey = prSummaryRefreshActionKey(workflow.id, target.identifier, target.generation);
  const existing = options.store.getWorkerAction?.(PR_SUMMARY_REFRESH_WORKER_KIND, externalKey);
  const cwd = mergeTask.execution.workspacePath ?? options.cwd ?? process.cwd();
  const workerActions = options.store.listWorkerActions?.({ workflowId: workflow.id }) ?? [];
  const desiredBody = buildPrSummaryRefreshBody({
    workflow,
    tasks,
    workerActions,
    title: target.title ?? workflow.name,
  });

  let currentBody: string;
  try {
    currentBody = await provider.getReviewBody({ identifier: target.identifier, cwd });
  } catch (err) {
    const record = recordRefreshAction(options, {
      existing,
      workflow,
      mergeTask,
      target,
      status: 'failed',
      summary: `PR summary refresh failed while reading body: ${errorMessage(err)}`,
      payload: { reason: 'read-body-failed', error: errorMessage(err), cwd },
      incrementAttempt: true,
    });
    if (record) logTaskWorkerAction(options, mergeTask, record, 'failed', { reason: 'read-body-failed', prNumber: target.identifier });
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to read PR ${target.identifier} body`, {
      module: 'pr-summary-refresh-worker',
      workflowId: workflow.id,
      err,
    });
    return;
  }

  if (sameBody(currentBody, desiredBody)) {
    const record = recordRefreshAction(options, {
      existing,
      workflow,
      mergeTask,
      target,
      status: 'skipped',
      summary: 'PR summary already current',
      payload: { reason: 'body-current', pipelineActionCount: pipelineActions(workerActions).length },
      incrementAttempt: false,
    });
    if (record) logTaskWorkerAction(options, mergeTask, record, 'skipped', { reason: 'body-current', prNumber: target.identifier });
    return;
  }

  const running = recordRefreshAction(options, {
    existing,
    workflow,
    mergeTask,
    target,
    status: 'running',
    summary: 'Refreshing PR summary with pipeline actions',
    payload: {
      bodyLength: desiredBody.length,
      pipelineActionCount: pipelineActions(workerActions).length,
      cwd,
    },
    incrementAttempt: true,
  });
  if (running) logTaskWorkerAction(options, mergeTask, running, 'running', { prNumber: target.identifier });

  try {
    await provider.updateReviewBody({ identifier: target.identifier, cwd, body: desiredBody });
    const record = recordRefreshAction(options, {
      existing: running ?? existing,
      workflow,
      mergeTask,
      target,
      status: 'completed',
      summary: 'PR summary refreshed with pipeline actions',
      payload: {
        bodyLength: desiredBody.length,
        pipelineActionCount: pipelineActions(workerActions).length,
        changed: true,
      },
      incrementAttempt: false,
    });
    if (record) logTaskWorkerAction(options, mergeTask, record, 'completed', { prNumber: target.identifier, changed: true });
  } catch (err) {
    const record = recordRefreshAction(options, {
      existing: running ?? existing,
      workflow,
      mergeTask,
      target,
      status: 'failed',
      summary: `PR summary refresh failed: ${errorMessage(err)}`,
      payload: { reason: 'update-body-failed', error: errorMessage(err) },
      incrementAttempt: false,
    });
    if (record) logTaskWorkerAction(options, mergeTask, record, 'failed', { reason: 'update-body-failed', prNumber: target.identifier });
    options.logger.warn(`[worker:${PR_SUMMARY_REFRESH_WORKER_KIND}] failed to update PR ${target.identifier} body`, {
      module: 'pr-summary-refresh-worker',
      workflowId: workflow.id,
      err,
    });
  }
}

function buildPrSummaryAuthoringContext(args: {
  workflow: Pick<Workflow, 'id'> & Partial<Workflow>;
  tasks: readonly TaskState[];
  workerActions: readonly WorkerActionRecord[];
}): PrAuthoringContext {
  const taskEntries: PrAuthoringTaskEntry[] = args.tasks
    .filter((task) => !task.config.isMergeNode)
    .map((task) => ({
      taskId: task.id,
      description: task.description,
      status: task.status === 'completed' ? 'completed' : task.status === 'failed' ? 'failed' : 'skipped',
      command: task.config.command ?? undefined,
    }));

  return {
    workflowName: args.workflow.name,
    workflowDescription: args.workflow.description,
    tasks: taskEntries,
    workerActions: pipelineActions(args.workerActions).map(toPrAuthoringWorkerAction),
  };
}

function pipelineActions(actions: readonly WorkerActionRecord[]): WorkerActionRecord[] {
  return actions.filter((action) => action.workerKind !== PR_SUMMARY_REFRESH_WORKER_KIND);
}

function toPrAuthoringWorkerAction(action: WorkerActionRecord): PrAuthoringWorkerActionEntry {
  return {
    id: action.id,
    workerKind: action.workerKind,
    actionType: action.actionType,
    status: action.status,
    taskId: action.taskId,
    subjectId: action.subjectId,
    summary: action.summary,
    createdAt: action.createdAt,
    updatedAt: action.updatedAt,
    completedAt: action.completedAt,
  };
}

function buildWorkflowSummary(workflow: Pick<Workflow, 'id'> & Partial<Workflow>, tasks: readonly TaskState[]): string {
  const workflowTasks = tasks.filter((task) => !task.config.isMergeNode);
  const completed = workflowTasks.filter((task) => task.status === 'completed').length;
  const failed = workflowTasks.filter((task) => task.status === 'failed').length;
  const skipped = workflowTasks.length - completed - failed;
  return `${workflow.name ?? workflow.id} — ${completed} completed, ${failed} failed, ${skipped} skipped.`;
}

function sameBody(a: string, b: string): boolean {
  return a.trimEnd() === b.trimEnd();
}

function recordRefreshAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  args: {
    existing?: WorkerActionRecord;
    workflow: Pick<Workflow, 'id'> & Partial<Workflow>;
    mergeTask: TaskState;
    target: RefreshTarget;
    status: WorkerActionStatus;
    summary: string;
    payload: Record<string, unknown>;
    incrementAttempt: boolean;
  },
): WorkerActionRecord | undefined {
  const externalKey = prSummaryRefreshActionKey(args.workflow.id, args.target.identifier, args.target.generation);
  const now = (options.now?.() ?? new Date()).toISOString();
  return options.store.upsertWorkerAction?.({
    id: args.existing?.id ?? `${PR_SUMMARY_REFRESH_WORKER_KIND}:${externalKey}`,
    workerKind: PR_SUMMARY_REFRESH_WORKER_KIND,
    actionType: REFRESH_ACTION_TYPE,
    workflowId: args.workflow.id,
    taskId: args.mergeTask.id,
    subjectType: 'pull_request',
    subjectId: args.target.identifier,
    externalKey,
    status: args.status,
    attemptCount: args.incrementAttempt ? (args.existing?.attemptCount ?? 0) + 1 : args.existing?.attemptCount ?? 0,
    summary: args.summary,
    payload: {
      workflowGeneration: args.workflow.generation ?? args.target.generation,
      prNumber: args.target.identifier,
      prUrl: args.target.url ?? null,
      headBranch: args.target.branch ?? args.mergeTask.execution.branch ?? null,
      baseBranch: args.target.baseBranch ?? args.workflow.baseBranch ?? null,
      ...args.payload,
    },
    updatedAt: now,
    ...(args.status === 'completed' || args.status === 'failed' || args.status === 'skipped' ? { completedAt: now } : {}),
  });
}

function logTaskWorkerAction(
  options: PrSummaryRefreshWorkerPolicyOptions,
  mergeTask: TaskState,
  action: WorkerActionRecord,
  phase: string,
  details: Record<string, unknown>,
): void {
  options.store.logEvent?.(mergeTask.id, TASK_WORKER_ACTION_EVENT, {
    worker: PR_SUMMARY_REFRESH_WORKER_KIND,
    phase,
    actionId: action.id,
    actionType: action.actionType,
    status: action.status,
    workflowId: mergeTask.config.workflowId ?? action.workflowId,
    prNumber: action.subjectId,
    summary: action.summary ?? null,
    ...details,
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

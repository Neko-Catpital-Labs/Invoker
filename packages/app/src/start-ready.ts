import type {
  Logger,
  StartReadyFreshBaseScope,
  StartReadyFreshBaseWorkflowStatus,
  StartReadyPartialOutcome,
  StartReadyPreview,
  StartReadyRequest,
  StartReadyResult,
} from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import type { CommandService, Orchestrator, TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationTiming } from './workflow-mutation-timing.js';
import { recreateWorkflowFromFreshBase as recreateWorkflowFromFreshBaseAction } from './workflow-actions.js';

type StartReadyOrchestrator = Pick<
  Orchestrator,
  | 'syncAllFromDb'
  | 'getAllTasks'
  | 'getPersistedActiveTaskIds'
  | 'getExecutableReadyTasks'
  | 'prepareTaskForNewAttempt'
  | 'recreateWorkflow'
  | 'startExecution'
> & Partial<Pick<Orchestrator, 'getKnownFreshBaseCommit'>>;

type StartReadyPreviewExt = StartReadyPreview & {
  pendingWorkflowIds: string[];
  runningWorkflowIds: string[];
  completedWorkflowIds: string[];
  skipped: StartReadyPreview['skipped'] & {
    pendingTasks: number;
    runningTasks: number;
    completedTasks: number;
  };
};

export interface StartReadyRunOptions {
  logger?: Logger | undefined;
  persistence?: SQLiteAdapter | undefined;
  commandService?: CommandService | undefined;
  taskExecutor?: TaskRunner | undefined;
  getTaskExecutor?: (() => TaskRunner | undefined) | undefined;
  mutationTiming?: WorkflowMutationTiming | undefined;
  recreateWorkflowFromFreshBase?: ((workflowId: string) => Promise<TaskState[]>) | undefined;
}

const FRESH_BASE_SCOPES = new Set<StartReadyFreshBaseScope>([
  'failed',
  'failed_and_pending',
  'failed_pending_and_running',
  'all',
]);

function collectRecoverableTasks(orchestrator: StartReadyOrchestrator): TaskState[] {
  const activeTaskIds = orchestrator.getPersistedActiveTaskIds();
  return orchestrator
    .getAllTasks()
    .filter((task) => !activeTaskIds.has(task.id) && isTaskRecoverableOnExplicitResume(task));
}

export function isTaskRecoverableOnExplicitResume(task: TaskState): boolean {
  if (task.status === 'running') return true;
  if (task.status !== 'pending' || !task.execution.selectedAttemptId) return false;
  if (task.execution.phase === 'launching') return true;

  return Boolean(
    task.execution.startedAt
    || task.execution.launchStartedAt
    || task.execution.launchCompletedAt
    || task.execution.lastHeartbeatAt
    || task.execution.workspacePath
    || task.execution.agentSessionId
    || task.execution.containerId
    || task.execution.error
    || task.execution.exitCode !== undefined
    || task.execution.inputPrompt
    || task.execution.pendingFixError,
  );
}

function uniqueWorkflowIds(tasks: readonly TaskState[]): string[] {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (task.config.workflowId) ids.add(task.config.workflowId);
  }
  return Array.from(ids);
}

function uniqueTasks(tasks: readonly TaskState[]): TaskState[] {
  const seen = new Set<string>();
  const result: TaskState[] = [];
  for (const task of tasks) {
    const attemptId = task.execution.selectedAttemptId?.trim();
    const key = attemptId ? `${task.id}:${attemptId}` : task.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(task);
  }
  return result;
}

function isPendingOrQueued(task: TaskState): boolean {
  return task.status === 'pending' || (task.status as string) === 'queued';
}

function unionWorkflowIds(...groups: readonly (readonly string[])[]): string[] {
  const ids = new Set<string>();
  for (const group of groups) {
    for (const id of group) ids.add(id);
  }
  return Array.from(ids);
}

function workflowIdsToRecreate(
  request: StartReadyRequest,
  preview: StartReadyPreviewExt,
): string[] {
  if (request.recreateAll) {
    return unionWorkflowIds(
      preview.failedWorkflowIds,
      preview.pendingWorkflowIds,
      preview.runningWorkflowIds,
      preview.completedWorkflowIds,
    );
  }
  if (request.recreateFailedPendingAndRunning) {
    return unionWorkflowIds(
      preview.failedWorkflowIds,
      preview.pendingWorkflowIds,
      preview.runningWorkflowIds,
    );
  }
  if (request.recreateFailedAndPending) {
    return unionWorkflowIds(preview.failedWorkflowIds, preview.pendingWorkflowIds);
  }
  if (request.recreateFailed) {
    return [...preview.failedWorkflowIds];
  }
  return [];
}

function normalizeFreshBaseScope(scope: StartReadyRequest['freshBaseScope']): StartReadyFreshBaseScope | undefined {
  return FRESH_BASE_SCOPES.has(scope as StartReadyFreshBaseScope)
    ? scope as StartReadyFreshBaseScope
    : undefined;
}

function uniqueRequestedFreshBaseWorkflowIds(request: StartReadyRequest): string[] {
  if (!Array.isArray(request.freshBaseWorkflowIds)) return [];
  const workflowIds = new Set<string>();
  for (const rawWorkflowId of request.freshBaseWorkflowIds) {
    if (typeof rawWorkflowId !== 'string') continue;
    const workflowId = rawWorkflowId.trim();
    if (workflowId) workflowIds.add(workflowId);
  }
  return Array.from(workflowIds);
}

function legacyRecreateScope(request: StartReadyRequest): StartReadyFreshBaseScope | undefined {
  if (request.recreateAll) return 'all';
  if (request.recreateFailedPendingAndRunning) return 'failed_pending_and_running';
  if (request.recreateFailedAndPending) return 'failed_and_pending';
  if (request.recreateFailed) return 'failed';
  return undefined;
}

export function isStartReadyFreshBaseRequested(request: StartReadyRequest = {}): boolean {
  if (request.freshBase === false) return false;
  return request.freshBase === true
    || normalizeFreshBaseScope(request.freshBaseScope) !== undefined
    || uniqueRequestedFreshBaseWorkflowIds(request).length > 0;
}

function freshBaseScopeForRequest(request: StartReadyRequest): StartReadyFreshBaseScope {
  return normalizeFreshBaseScope(request.freshBaseScope)
    ?? legacyRecreateScope(request)
    ?? 'failed';
}

function workflowIdsForFreshBase(
  request: StartReadyRequest,
  preview: StartReadyPreviewExt,
): string[] {
  const requestedWorkflowIds = uniqueRequestedFreshBaseWorkflowIds(request);
  if (requestedWorkflowIds.length > 0) return requestedWorkflowIds;
  if (!isStartReadyFreshBaseRequested(request)) return [];

  switch (freshBaseScopeForRequest(request)) {
    case 'all':
      return unionWorkflowIds(
        preview.failedWorkflowIds,
        preview.pendingWorkflowIds,
        preview.runningWorkflowIds,
        preview.completedWorkflowIds,
      );
    case 'failed_pending_and_running':
      return unionWorkflowIds(
        preview.failedWorkflowIds,
        preview.pendingWorkflowIds,
        preview.runningWorkflowIds,
      );
    case 'failed_and_pending':
      return unionWorkflowIds(preview.failedWorkflowIds, preview.pendingWorkflowIds);
    case 'failed':
      return [...preview.failedWorkflowIds];
  }
}

function workflowStatusForPreview(
  workflowId: string,
  preview: StartReadyPreviewExt,
): StartReadyFreshBaseWorkflowStatus {
  if (preview.failedWorkflowIds.includes(workflowId)) return 'failed';
  if (preview.pendingWorkflowIds.includes(workflowId)) return 'pending';
  if (preview.runningWorkflowIds.includes(workflowId)) return 'running';
  return 'completed';
}

function workflowBaseBranch(
  workflowId: string,
  options: StartReadyRunOptions,
): string | undefined {
  return options.persistence?.loadWorkflow(workflowId)?.baseBranch?.trim() || undefined;
}

function augmentFreshBasePreview(
  preview: StartReadyPreviewExt,
  workflowIds: readonly string[],
  options: StartReadyRunOptions,
): void {
  if (workflowIds.length === 0) return;
  preview.freshBaseWorkflowIds = [...workflowIds];
  preview.freshBaseWorkflows = workflowIds.map((workflowId) => {
    const baseBranch = workflowBaseBranch(workflowId, options);
    return {
      workflowId,
      status: workflowStatusForPreview(workflowId, preview),
      ...(baseBranch ? { baseBranch } : {}),
    };
  });
}

function freshBaseCommitForWorkflow(
  orchestrator: StartReadyOrchestrator,
  workflowId: string,
): string | undefined {
  return orchestrator.getKnownFreshBaseCommit?.(workflowId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildFreshBaseRecreate(
  orchestrator: StartReadyOrchestrator,
  options: StartReadyRunOptions,
): (workflowId: string) => Promise<TaskState[]> {
  if (options.recreateWorkflowFromFreshBase) return options.recreateWorkflowFromFreshBase;
  if (!options.persistence || !options.commandService) {
    throw new Error('Start Ready fresh-base recreation requires persistence and commandService dependencies.');
  }
  return (workflowId) => {
    const deps: Parameters<typeof recreateWorkflowFromFreshBaseAction>[1] = {
      orchestrator: orchestrator as Orchestrator,
      persistence: options.persistence!,
      commandService: options.commandService!,
    };
    if (options.logger) deps.logger = options.logger;
    const taskExecutor = options.taskExecutor ?? options.getTaskExecutor?.();
    if (taskExecutor) deps.taskExecutor = taskExecutor;
    if (options.mutationTiming) deps.mutationTiming = options.mutationTiming;
    return recreateWorkflowFromFreshBaseAction(workflowId, deps);
  };
}

async function recreateFreshBaseWorkflows(
  orchestrator: StartReadyOrchestrator,
  workflowIds: readonly string[],
  options: StartReadyRunOptions,
): Promise<{
  started: TaskState[];
  recreatedWorkflowIds: string[];
  partialOutcomes: StartReadyPartialOutcome[];
  partial: boolean;
}> {
  const recreateFreshBaseWorkflow = buildFreshBaseRecreate(orchestrator, options);
  const started: TaskState[] = [];
  const recreatedWorkflowIds: string[] = [];
  const partialOutcomes: StartReadyPartialOutcome[] = [];

  for (const workflowId of workflowIds) {
    try {
      const workflowStarted = await recreateFreshBaseWorkflow(workflowId);
      started.push(...workflowStarted);
      recreatedWorkflowIds.push(workflowId);
      const outcome: StartReadyPartialOutcome = {
        workflowId,
        ok: true,
        startedTaskIds: workflowStarted.map((task) => task.id),
      };
      const freshBaseBranch = workflowBaseBranch(workflowId, options);
      const freshBaseCommit = freshBaseCommitForWorkflow(orchestrator, workflowId);
      if (freshBaseBranch) outcome.freshBaseBranch = freshBaseBranch;
      if (freshBaseCommit) outcome.freshBaseCommit = freshBaseCommit;
      partialOutcomes.push(outcome);
    } catch (err) {
      const message = errorMessage(err);
      options.logger?.warn?.(
        `start-ready: fresh-base recreate failed for workflow ${workflowId}: ${message}`,
        { module: 'start-ready', workflowId },
      );
      const outcome: StartReadyPartialOutcome = {
        workflowId,
        ok: false,
        error: message,
      };
      const freshBaseBranch = workflowBaseBranch(workflowId, options);
      const freshBaseCommit = freshBaseCommitForWorkflow(orchestrator, workflowId);
      if (freshBaseBranch) outcome.freshBaseBranch = freshBaseBranch;
      if (freshBaseCommit) outcome.freshBaseCommit = freshBaseCommit;
      partialOutcomes.push(outcome);
    }
  }

  return {
    started,
    recreatedWorkflowIds,
    partialOutcomes,
    partial: partialOutcomes.some((outcome) => !outcome.ok),
  };
}

export function collectStartReadyPreview(orchestrator: StartReadyOrchestrator): StartReadyPreview {
  const tasks = orchestrator.getAllTasks();
  const readyTasks = orchestrator.getExecutableReadyTasks();
  const recoverableTasks = collectRecoverableTasks(orchestrator);
  const failedTasks = tasks.filter((task) => task.status === 'failed');
  const pendingTasks = tasks.filter((task) => isPendingOrQueued(task));
  const runningTasks = tasks.filter((task) => task.status === 'running');
  const completedTasks = tasks.filter((task) => task.status === 'completed');

  const preview: StartReadyPreviewExt = {
    readyTaskIds: readyTasks.map((task) => task.id),
    recoverableTaskIds: recoverableTasks.map((task) => task.id),
    failedWorkflowIds: uniqueWorkflowIds(failedTasks),
    pendingWorkflowIds: uniqueWorkflowIds(pendingTasks),
    runningWorkflowIds: uniqueWorkflowIds(runningTasks),
    completedWorkflowIds: uniqueWorkflowIds(completedTasks),
    skipped: {
      awaitingApproval: tasks.filter((task) => task.status === 'awaiting_approval').length,
      reviewReady: tasks.filter((task) => task.status === 'review_ready').length,
      blocked: tasks.filter((task) => task.status === 'blocked' || task.status === 'needs_input').length,
      failedTasks: failedTasks.length,
      pendingTasks: pendingTasks.length,
      runningTasks: runningTasks.length,
      completedTasks: completedTasks.length,
    },
  };
  return preview;
}

export async function runStartReady(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyRequest = {},
  options: StartReadyRunOptions = {},
): Promise<StartReadyResult> {
  orchestrator.syncAllFromDb();
  const preview = collectStartReadyPreview(orchestrator) as StartReadyPreviewExt;
  const freshBaseWorkflowIds = workflowIdsForFreshBase(request, preview);
  augmentFreshBasePreview(preview, freshBaseWorkflowIds, options);
  if (request.dryRun) {
    return {
      preview,
      started: [],
      recreatedWorkflowIds: [],
      ...(freshBaseWorkflowIds.length > 0 ? { freshBaseWorkflowIds } : {}),
      dryRun: true,
    };
  }

  const started: TaskState[] = [];
  let recreatedWorkflowIds: string[] = [];
  let partialOutcomes: StartReadyPartialOutcome[] | undefined;
  let partial = false;

  if (freshBaseWorkflowIds.length > 0) {
    const freshBaseResult = await recreateFreshBaseWorkflows(orchestrator, freshBaseWorkflowIds, options);
    started.push(...freshBaseResult.started);
    recreatedWorkflowIds = freshBaseResult.recreatedWorkflowIds;
    partialOutcomes = freshBaseResult.partialOutcomes;
    partial = freshBaseResult.partial;
  } else {
    for (const workflowId of workflowIdsToRecreate(request, preview)) {
      started.push(...orchestrator.recreateWorkflow(workflowId));
      recreatedWorkflowIds.push(workflowId);
    }
  }

  const recoverableTasks = collectRecoverableTasks(orchestrator);
  for (const task of recoverableTasks) {
    orchestrator.prepareTaskForNewAttempt(task.id, 'start_ready_recovery');
  }

  started.push(...orchestrator.startExecution());

  return {
    preview,
    started: uniqueTasks(started),
    recreatedWorkflowIds,
    ...(freshBaseWorkflowIds.length > 0 ? { freshBaseWorkflowIds } : {}),
    ...(partialOutcomes ? { partialOutcomes, partial } : {}),
    dryRun: false,
  };
}

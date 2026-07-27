import type {
  StartReadyFreshBasePreview,
  StartReadyFreshBaseScope,
  StartReadyPartialOutcome,
  StartReadyPreview,
  StartReadyRequest,
  StartReadyResult,
} from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';

type StartReadyOrchestrator = Pick<
  Orchestrator,
  | 'syncAllFromDb'
  | 'getAllTasks'
  | 'getPersistedActiveTaskIds'
  | 'getExecutableReadyTasks'
  | 'prepareTaskForNewAttempt'
  | 'recreateWorkflow'
  | 'startExecution'
>;

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

export interface StartReadyFreshBaseRecreateResult {
  started: TaskState[];
  freshBaseBranch?: string;
  freshBaseCommit?: string;
}

export interface StartReadyRunOptions {
  recreateWorkflowFromFreshBase?: (
    workflowId: string,
  ) => Promise<TaskState[] | StartReadyFreshBaseRecreateResult>;
}

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

function uniqueRequestedWorkflowIds(workflowIds: readonly string[] | undefined): string[] {
  const ids = new Set<string>();
  for (const rawId of workflowIds ?? []) {
    const workflowId = rawId.trim();
    if (workflowId.length > 0) ids.add(workflowId);
  }
  return Array.from(ids);
}

function isFreshBaseRequested(request: StartReadyRequest): boolean {
  if (request.freshBase === false) return false;
  return Boolean(
    request.freshBase
    || request.freshBaseScope
    || uniqueRequestedWorkflowIds(request.freshBaseWorkflowIds).length > 0,
  );
}

function freshBaseScopeForRequest(request: StartReadyRequest): StartReadyFreshBaseScope {
  switch (request.freshBaseScope) {
    case 'failed':
    case 'failed_and_pending':
    case 'failed_pending_and_running':
    case 'all':
      return request.freshBaseScope;
    default:
      break;
  }
  if (request.recreateAll) return 'all';
  if (request.recreateFailedPendingAndRunning) return 'failed_pending_and_running';
  if (request.recreateFailedAndPending) return 'failed_and_pending';
  return 'failed';
}

function workflowIdsForFreshBaseScope(
  scope: StartReadyFreshBaseScope,
  preview: StartReadyPreviewExt,
): string[] {
  switch (scope) {
    case 'failed':
      return [...preview.failedWorkflowIds];
    case 'failed_and_pending':
      return unionWorkflowIds(preview.failedWorkflowIds, preview.pendingWorkflowIds);
    case 'failed_pending_and_running':
      return unionWorkflowIds(
        preview.failedWorkflowIds,
        preview.pendingWorkflowIds,
        preview.runningWorkflowIds,
      );
    case 'all':
      return unionWorkflowIds(
        preview.failedWorkflowIds,
        preview.pendingWorkflowIds,
        preview.runningWorkflowIds,
        preview.completedWorkflowIds,
      );
  }
}

function workflowIdsToFreshBase(
  request: StartReadyRequest,
  preview: StartReadyPreviewExt,
): string[] {
  const requestedWorkflowIds = uniqueRequestedWorkflowIds(request.freshBaseWorkflowIds);
  if (requestedWorkflowIds.length > 0) return requestedWorkflowIds;
  return workflowIdsForFreshBaseScope(freshBaseScopeForRequest(request), preview);
}

function freshBaseStatusForWorkflow(
  workflowId: string,
  preview: StartReadyPreviewExt,
): StartReadyFreshBasePreview['status'] | undefined {
  if (preview.failedWorkflowIds.includes(workflowId)) return 'failed';
  if (preview.pendingWorkflowIds.includes(workflowId)) return 'pending';
  if (preview.runningWorkflowIds.includes(workflowId)) return 'running';
  if (preview.completedWorkflowIds.includes(workflowId)) return 'completed';
  return undefined;
}

function collectFreshBaseWorkflowPreviews(
  workflowIds: readonly string[],
  preview: StartReadyPreviewExt,
): StartReadyFreshBasePreview[] {
  const workflows: StartReadyFreshBasePreview[] = [];
  for (const workflowId of workflowIds) {
    const status = freshBaseStatusForWorkflow(workflowId, preview);
    if (!status) continue;
    workflows.push({ workflowId, status });
  }
  return workflows;
}

function normalizeFreshBaseRecreateResult(
  result: TaskState[] | StartReadyFreshBaseRecreateResult,
): StartReadyFreshBaseRecreateResult {
  return Array.isArray(result) ? { started: result } : result;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
  const freshBaseRequested = isFreshBaseRequested(request);
  const freshBaseWorkflowIds = freshBaseRequested
    ? workflowIdsToFreshBase(request, preview)
    : [];
  if (freshBaseRequested) {
    preview.freshBaseWorkflowIds = freshBaseWorkflowIds;
    preview.freshBaseWorkflows = collectFreshBaseWorkflowPreviews(freshBaseWorkflowIds, preview);
  }

  if (request.dryRun) {
    return {
      preview,
      started: [],
      recreatedWorkflowIds: [],
      ...(freshBaseRequested ? { freshBaseWorkflowIds } : {}),
      dryRun: true,
    };
  }

  const started: TaskState[] = [];
  const recreatedWorkflowIds: string[] = [];
  let partialOutcomes: StartReadyPartialOutcome[] | undefined;
  if (freshBaseRequested) {
    partialOutcomes = [];
    for (const workflowId of freshBaseWorkflowIds) {
      try {
        if (!options.recreateWorkflowFromFreshBase) {
          throw new Error('Start Ready fresh-base recreation is not configured');
        }
        const outcome = normalizeFreshBaseRecreateResult(
          await options.recreateWorkflowFromFreshBase(workflowId),
        );
        started.push(...outcome.started);
        recreatedWorkflowIds.push(workflowId);
        partialOutcomes.push({
          workflowId,
          ok: true,
          startedTaskIds: outcome.started.map((task) => task.id),
          ...(outcome.freshBaseBranch ? { freshBaseBranch: outcome.freshBaseBranch } : {}),
          ...(outcome.freshBaseCommit ? { freshBaseCommit: outcome.freshBaseCommit } : {}),
        });
      } catch (error) {
        partialOutcomes.push({
          workflowId,
          ok: false,
          error: errorMessage(error),
        });
      }
    }
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
    ...(freshBaseRequested ? { freshBaseWorkflowIds } : {}),
    ...(partialOutcomes ? { partialOutcomes } : {}),
    ...(partialOutcomes?.some((outcome) => !outcome.ok) ? { partial: true } : {}),
    dryRun: false,
  };
}

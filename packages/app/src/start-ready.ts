import type {
  StartReadyFreshBasePreview,
  StartReadyFreshBaseRequest,
  StartReadyFreshBaseScope,
  StartReadyPartialOutcome,
  StartReadyPreview,
  StartReadyRequest,
  StartReadyResult,
} from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import {
  recreateWorkflowFromFreshBase as recreateWorkflowFromFreshBaseAction,
  type CommandActionDeps,
} from './workflow-actions.js';

type StartReadyOrchestrator = Pick<
  Orchestrator,
  | 'syncAllFromDb'
  | 'getAllTasks'
  | 'getPersistedActiveTaskIds'
  | 'getExecutableReadyTasks'
  | 'prepareTaskForNewAttempt'
  | 'getTask'
  | 'recreateWorkflow'
  | 'startExecution'
>;

export interface StartReadyFreshBaseActions {
  recreateWorkflowFromFreshBase(workflowId: string): Promise<TaskState[]>;
}

export interface RunStartReadyOptions {
  freshBase?: StartReadyFreshBaseActions;
}

export function createStartReadyFreshBaseActions(
  resolveDeps: () => CommandActionDeps,
): StartReadyFreshBaseActions {
  return {
    recreateWorkflowFromFreshBase: (workflowId) =>
      recreateWorkflowFromFreshBaseAction(workflowId, resolveDeps()),
  };
}

type FreshBasePlan = {
  preview: StartReadyFreshBasePreview;
  workflowIds: string[];
};

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

function normalizeIds(ids: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const id of ids ?? []) {
    const normalized = id.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

function workflowIdsForTaskIds(
  orchestrator: StartReadyOrchestrator,
  taskIds: readonly string[] | undefined,
): string[] {
  const ids = new Set<string>();
  for (const taskId of normalizeIds(taskIds)) {
    const workflowId = orchestrator.getTask(taskId)?.config.workflowId;
    if (workflowId) ids.add(workflowId);
  }
  return Array.from(ids);
}

function freshBaseEnabled(request: StartReadyFreshBaseRequest | undefined): request is StartReadyFreshBaseRequest {
  return Boolean(request && request.enabled !== false);
}

function freshBaseScope(request: StartReadyFreshBaseRequest): StartReadyFreshBaseScope {
  return request.scope ?? 'failed';
}

function freshBaseWorkflowIdsForScope(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyFreshBaseRequest,
  preview: StartReadyPreviewExt,
): string[] {
  switch (freshBaseScope(request)) {
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
    case 'custom':
      return unionWorkflowIds(
        normalizeIds(request.workflowIds),
        workflowIdsForTaskIds(orchestrator, request.taskIds),
      );
  }
}

function collectFreshBasePlan(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyRequest,
  preview: StartReadyPreviewExt,
): FreshBasePlan | undefined {
  if (!freshBaseEnabled(request.freshBase)) return undefined;

  const scope = freshBaseScope(request.freshBase);
  const workflowIds = freshBaseWorkflowIdsForScope(orchestrator, request.freshBase, preview);
  const selected = new Set(workflowIds);
  const taskIds = normalizeIds(request.freshBase.taskIds);
  return {
    workflowIds,
    preview: {
      scope,
      workflowIds,
      ...(taskIds.length > 0 ? { taskIds } : {}),
      failedWorkflowIds: preview.failedWorkflowIds.filter((id) => selected.has(id)),
      pendingWorkflowIds: preview.pendingWorkflowIds.filter((id) => selected.has(id)),
      runningWorkflowIds: preview.runningWorkflowIds.filter((id) => selected.has(id)),
      completedWorkflowIds: preview.completedWorkflowIds.filter((id) => selected.has(id)),
    },
  };
}

function errorMessageForWorkflow(workflowId: string, err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `fresh-base recreate failed for workflow ${workflowId}: ${detail}`;
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
  options: RunStartReadyOptions = {},
): Promise<StartReadyResult> {
  orchestrator.syncAllFromDb();
  const preview = collectStartReadyPreview(orchestrator) as StartReadyPreviewExt;
  const freshBasePlan = collectFreshBasePlan(orchestrator, request, preview);
  if (freshBasePlan) {
    preview.freshBase = freshBasePlan.preview;
  }
  if (request.dryRun) {
    const result: StartReadyResult = {
      preview,
      started: [],
      recreatedWorkflowIds: [],
      dryRun: true,
    };
    if (freshBasePlan) {
      result.freshBaseRecreatedWorkflowIds = [];
      result.partialOutcomes = [];
    }
    return result;
  }

  const started: TaskState[] = [];
  const recreatedWorkflowIds: string[] = [];
  const freshBaseRecreatedWorkflowIds: string[] = [];
  const partialOutcomes: StartReadyPartialOutcome[] = [];
  const errors: string[] = [];

  if (freshBasePlan) {
    for (const workflowId of freshBasePlan.workflowIds) {
      if (!options.freshBase) {
        const error = errorMessageForWorkflow(workflowId, new Error('fresh-base executor unavailable'));
        partialOutcomes.push({ workflowId, ok: false, error });
        errors.push(error);
        continue;
      }
      try {
        const freshBaseStarted = await options.freshBase.recreateWorkflowFromFreshBase(workflowId);
        started.push(...freshBaseStarted);
        freshBaseRecreatedWorkflowIds.push(workflowId);
        partialOutcomes.push({
          workflowId,
          ok: true,
          startedTaskIds: freshBaseStarted.map((task) => task.id),
        });
      } catch (err) {
        const error = errorMessageForWorkflow(workflowId, err);
        partialOutcomes.push({ workflowId, ok: false, error });
        errors.push(error);
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

  const result: StartReadyResult = {
    preview,
    started: uniqueTasks(started),
    recreatedWorkflowIds,
    dryRun: false,
  };
  if (freshBasePlan) {
    result.freshBaseRecreatedWorkflowIds = freshBaseRecreatedWorkflowIds;
    result.partialOutcomes = partialOutcomes;
    if (errors.length > 0) result.errors = errors;
  }
  return result;
}

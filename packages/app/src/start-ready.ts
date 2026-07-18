import type {
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
  preview: StartReadyPreview,
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

export function collectStartReadyPreview(orchestrator: StartReadyOrchestrator): StartReadyPreview {
  const tasks = orchestrator.getAllTasks();
  const readyTasks = orchestrator.getExecutableReadyTasks();
  const recoverableTasks = collectRecoverableTasks(orchestrator);
  const failedTasks = tasks.filter((task) => task.status === 'failed');
  const pendingTasks = tasks.filter((task) => isPendingOrQueued(task));
  const runningTasks = tasks.filter((task) => task.status === 'running');
  const completedTasks = tasks.filter((task) => task.status === 'completed');

  return {
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
}

export function runStartReady(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyRequest = {},
): StartReadyResult {
  orchestrator.syncAllFromDb();
  const preview = collectStartReadyPreview(orchestrator);
  if (request.dryRun) {
    return {
      preview,
      started: [],
      recreatedWorkflowIds: [],
      dryRun: true,
    };
  }

  const started: TaskState[] = [];
  const recreatedWorkflowIds: string[] = [];
  for (const workflowId of workflowIdsToRecreate(request, preview)) {
    started.push(...orchestrator.recreateWorkflow(workflowId));
    recreatedWorkflowIds.push(workflowId);
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
    dryRun: false,
  };
}

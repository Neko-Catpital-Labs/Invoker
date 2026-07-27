import type {
  StartReadyFreshBasePreview,
  StartReadyFreshBaseScope,
  StartReadyPreview,
  StartReadyRequest,
  StartReadyResult,
  StartReadyWorkflowOutcome,
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

type StartReadyRequestExt = StartReadyRequest & {
  recreateFailedAndPending?: boolean;
  recreateFailedPendingAndRunning?: boolean;
};

export interface StartReadyRunOptions {
  freshBaseRecreateWorkflow?: (workflowId: string) => Promise<TaskState[]>;
}

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
  request: StartReadyRequestExt,
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

function workflowIdsForFreshBaseScope(
  scope: StartReadyFreshBaseScope,
  preview: StartReadyPreviewExt,
): string[] {
  switch (scope) {
    case 'failed':
      return [...preview.failedWorkflowIds];
    case 'failed-and-pending':
      return unionWorkflowIds(preview.failedWorkflowIds, preview.pendingWorkflowIds);
    case 'failed-pending-and-running':
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

function collectFreshBasePreview(
  scope: StartReadyFreshBaseScope,
  preview: StartReadyPreviewExt,
): StartReadyFreshBasePreview {
  const includePending = scope === 'failed-and-pending'
    || scope === 'failed-pending-and-running'
    || scope === 'all';
  const includeRunning = scope === 'failed-pending-and-running'
    || scope === 'all';
  const includeCompleted = scope === 'all';

  return {
    scope,
    workflowIds: workflowIdsForFreshBaseScope(scope, preview),
    failedWorkflowIds: [...preview.failedWorkflowIds],
    pendingWorkflowIds: includePending ? [...preview.pendingWorkflowIds] : [],
    runningWorkflowIds: includeRunning ? [...preview.runningWorkflowIds] : [],
    completedWorkflowIds: includeCompleted ? [...preview.completedWorkflowIds] : [],
  };
}

function formatStartReadyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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

export function runStartReady(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyRequest = {},
  options: StartReadyRunOptions = {},
): Promise<StartReadyResult> {
  return runStartReadyAsync(orchestrator, request, options);
}

async function runStartReadyAsync(
  orchestrator: StartReadyOrchestrator,
  request: StartReadyRequest = {},
  options: StartReadyRunOptions = {},
): Promise<StartReadyResult> {
  const extendedRequest = request as StartReadyRequestExt;
  orchestrator.syncAllFromDb();
  const preview = collectStartReadyPreview(orchestrator) as StartReadyPreviewExt;
  const freshBasePreview = request.freshBaseScope
    ? collectFreshBasePreview(request.freshBaseScope, preview)
    : undefined;
  if (freshBasePreview) {
    preview.freshBase = freshBasePreview;
  }
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
  const freshBaseRecreatedWorkflowIds: string[] = [];
  const workflowOutcomes: StartReadyWorkflowOutcome[] = [];

  if (freshBasePreview) {
    if (freshBasePreview.workflowIds.length > 0 && !options.freshBaseRecreateWorkflow) {
      throw new Error('Start Ready fresh-base scope requires freshBaseRecreateWorkflow.');
    }
    for (const workflowId of freshBasePreview.workflowIds) {
      try {
        const workflowStarted = await options.freshBaseRecreateWorkflow!(workflowId);
        started.push(...workflowStarted);
        freshBaseRecreatedWorkflowIds.push(workflowId);
        workflowOutcomes.push({
          ok: true,
          workflowId,
          mode: 'fresh-base-recreate',
          startedTaskIds: workflowStarted.map((task) => task.id),
        });
      } catch (err) {
        workflowOutcomes.push({
          ok: false,
          workflowId,
          mode: 'fresh-base-recreate',
          error: formatStartReadyError(err),
        });
      }
    }
  } else {
    for (const workflowId of workflowIdsToRecreate(extendedRequest, preview)) {
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
    ...(freshBasePreview
      ? {
          freshBaseRecreatedWorkflowIds,
          workflowOutcomes,
          partial: workflowOutcomes.some((outcome) => !outcome.ok),
        }
      : {}),
    dryRun: false,
  };
}

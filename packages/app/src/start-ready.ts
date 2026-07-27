import type {
  StartReadyFreshBasePreview,
  StartReadyFreshBaseScope,
  StartReadyFreshBaseWorkflowStatus,
  StartReadyPartialOutcome,
  StartReadyPreview,
  StartReadyRequest,
  StartReadyResult,
} from '@invoker/contracts';
import type { Orchestrator, TaskState } from '@invoker/workflow-core';
import {
  recreateWorkflowFromFreshBase,
  type CommandActionDeps,
} from './workflow-actions.js';

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

type StartReadyFreshBaseDeps = Omit<CommandActionDeps, 'orchestrator'>;

type StartReadyRequestExt = StartReadyRequest & {
  recreateFailedAndPending?: boolean;
  recreateFailedPendingAndRunning?: boolean;
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

function freshBaseScopeFromLegacyFlags(
  request: StartReadyRequestExt,
): StartReadyFreshBaseScope {
  if (request.recreateAll) return 'all';
  if (request.recreateFailedPendingAndRunning) return 'failed_pending_and_running';
  if (request.recreateFailedAndPending) return 'failed_and_pending';
  return 'failed';
}

function isFreshBaseRequest(request: StartReadyRequestExt): boolean {
  return Boolean(
    request.freshBase
    || request.freshBaseScope
    || (request.freshBaseWorkflowIds && request.freshBaseWorkflowIds.length > 0),
  );
}

function explicitFreshBaseWorkflowIds(request: StartReadyRequestExt): string[] {
  const ids = new Set<string>();
  for (const workflowId of request.freshBaseWorkflowIds ?? []) {
    const normalized = workflowId.trim();
    if (normalized) ids.add(normalized);
  }
  return Array.from(ids);
}

function workflowIdsForFreshBaseScope(
  scope: StartReadyFreshBaseScope,
  preview: StartReadyPreviewExt,
): string[] {
  if (scope === 'all') {
    return unionWorkflowIds(
      preview.failedWorkflowIds,
      preview.pendingWorkflowIds,
      preview.runningWorkflowIds,
      preview.completedWorkflowIds,
    );
  }
  if (scope === 'failed_pending_and_running') {
    return unionWorkflowIds(
      preview.failedWorkflowIds,
      preview.pendingWorkflowIds,
      preview.runningWorkflowIds,
    );
  }
  if (scope === 'failed_and_pending') {
    return unionWorkflowIds(preview.failedWorkflowIds, preview.pendingWorkflowIds);
  }
  return [...preview.failedWorkflowIds];
}

function workflowIdsToFreshBase(
  request: StartReadyRequestExt,
  preview: StartReadyPreviewExt,
): string[] {
  const explicitIds = explicitFreshBaseWorkflowIds(request);
  if (explicitIds.length > 0) return explicitIds;
  if (!isFreshBaseRequest(request)) return [];
  return workflowIdsForFreshBaseScope(
    request.freshBaseScope ?? freshBaseScopeFromLegacyFlags(request),
    preview,
  );
}

function workflowStatusForFreshBasePreview(
  workflowId: string,
  preview: StartReadyPreviewExt,
): StartReadyFreshBaseWorkflowStatus | undefined {
  if (preview.failedWorkflowIds.includes(workflowId)) return 'failed';
  if (preview.pendingWorkflowIds.includes(workflowId)) return 'pending';
  if (preview.runningWorkflowIds.includes(workflowId)) return 'running';
  if (preview.completedWorkflowIds.includes(workflowId)) return 'completed';
  return undefined;
}

function loadWorkflowBaseBranch(
  deps: StartReadyFreshBaseDeps | undefined,
  workflowId: string,
): string | undefined {
  try {
    const workflow = deps?.persistence.loadWorkflow(workflowId);
    return typeof workflow?.baseBranch === 'string' ? workflow.baseBranch : undefined;
  } catch {
    return undefined;
  }
}

function freshBaseCommit(
  orchestrator: StartReadyOrchestrator,
  workflowId: string,
): string | undefined {
  return orchestrator.getKnownFreshBaseCommit?.(workflowId);
}

function attachFreshBasePreview(
  preview: StartReadyPreviewExt,
  workflowIds: readonly string[],
  orchestrator: StartReadyOrchestrator,
  deps: StartReadyFreshBaseDeps | undefined,
): void {
  preview.freshBaseWorkflowIds = [...workflowIds];
  const workflows: StartReadyFreshBasePreview[] = [];
  for (const workflowId of workflowIds) {
    const status = workflowStatusForFreshBasePreview(workflowId, preview);
    if (!status) continue;
    const baseBranch = loadWorkflowBaseBranch(deps, workflowId);
    const freshCommit = freshBaseCommit(orchestrator, workflowId);
    workflows.push({
      workflowId,
      status,
      ...(baseBranch ? { baseBranch } : {}),
      ...(freshCommit ? { freshBaseCommit: freshCommit } : {}),
    });
  }
  preview.freshBaseWorkflows = workflows;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function successfulFreshBaseOutcome(
  workflowId: string,
  started: readonly TaskState[],
  orchestrator: StartReadyOrchestrator,
  deps: StartReadyFreshBaseDeps,
): StartReadyPartialOutcome {
  const freshBranch = loadWorkflowBaseBranch(deps, workflowId);
  const freshCommit = freshBaseCommit(orchestrator, workflowId);
  return {
    workflowId,
    ok: true,
    startedTaskIds: started.map((task) => task.id),
    ...(freshBranch ? { freshBaseBranch: freshBranch } : {}),
    ...(freshCommit ? { freshBaseCommit: freshCommit } : {}),
  };
}

function failedFreshBaseOutcome(workflowId: string, err: unknown): StartReadyPartialOutcome {
  return {
    workflowId,
    ok: false,
    error: errorMessage(err),
  };
}

async function runFreshBaseRecreates(
  orchestrator: StartReadyOrchestrator,
  workflowIds: readonly string[],
  deps: StartReadyFreshBaseDeps | undefined,
): Promise<{
  started: TaskState[];
  recreatedWorkflowIds: string[];
  partialOutcomes: StartReadyPartialOutcome[];
}> {
  const started: TaskState[] = [];
  const recreatedWorkflowIds: string[] = [];
  const partialOutcomes: StartReadyPartialOutcome[] = [];

  for (const workflowId of workflowIds) {
    if (!deps) {
      partialOutcomes.push(failedFreshBaseOutcome(
        workflowId,
        new Error('Start Ready fresh-base execution requires workflow action dependencies'),
      ));
      continue;
    }
    try {
      const recreated = await recreateWorkflowFromFreshBase(workflowId, {
        ...deps,
        orchestrator: orchestrator as CommandActionDeps['orchestrator'],
      });
      started.push(...recreated);
      recreatedWorkflowIds.push(workflowId);
      partialOutcomes.push(successfulFreshBaseOutcome(
        workflowId,
        recreated,
        orchestrator,
        deps,
      ));
    } catch (err) {
      partialOutcomes.push(failedFreshBaseOutcome(workflowId, err));
    }
  }

  return { started, recreatedWorkflowIds, partialOutcomes };
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
  freshBaseDeps?: StartReadyFreshBaseDeps,
): Promise<StartReadyResult> {
  const extendedRequest = request as StartReadyRequestExt;
  orchestrator.syncAllFromDb();
  const preview = collectStartReadyPreview(orchestrator) as StartReadyPreviewExt;
  const freshBaseWorkflowIds = workflowIdsToFreshBase(extendedRequest, preview);
  if (isFreshBaseRequest(extendedRequest)) {
    attachFreshBasePreview(preview, freshBaseWorkflowIds, orchestrator, freshBaseDeps);
  }
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
  const recreatedWorkflowIds: string[] = [];
  const partialOutcomes: StartReadyPartialOutcome[] = [];

  if (isFreshBaseRequest(extendedRequest)) {
    const freshBaseResult = await runFreshBaseRecreates(
      orchestrator,
      freshBaseWorkflowIds,
      freshBaseDeps,
    );
    started.push(...freshBaseResult.started);
    recreatedWorkflowIds.push(...freshBaseResult.recreatedWorkflowIds);
    partialOutcomes.push(...freshBaseResult.partialOutcomes);
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
    ...(freshBaseWorkflowIds.length > 0 ? { freshBaseWorkflowIds } : {}),
    ...(partialOutcomes.length > 0 ? { partialOutcomes } : {}),
    ...(partialOutcomes.some((outcome) => !outcome.ok) ? { partial: true } : {}),
    dryRun: false,
  };
}

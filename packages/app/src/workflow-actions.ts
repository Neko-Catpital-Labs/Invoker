/**
 * Shared workflow action functions used by headless, GUI, and Slack surfaces.
 *
 * Each function performs an orchestrator mutation and returns TaskState[]
 * of affected tasks. The caller decides whether to executeTasks() and/or
 * waitForCompletion().
 */

import type { Orchestrator } from '@invoker/core';
import type { TaskState } from '@invoker/core';
import type { SQLiteAdapter } from '@invoker/persistence';
import type { TaskExecutor } from '@invoker/executors';
import { normalizeMergeModeForPersistence } from './merge-mode.js';

// ── Deps interfaces ──────────────────────────────────────────

export interface ActionDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  /** @deprecated Pool cleanup uses the workflow mirror; repoRoot branch deletion is no longer used. */
  repoRoot?: string;
  /** When set, rebase-and-refreshes the pool mirror and removes managed branches before bumping generation. */
  taskExecutor?: TaskExecutor;
}

// ── Actions ──────────────────────────────────────────────────

export function bumpGenerationAndRestart(
  workflowId: string,
  deps: Pick<ActionDeps, 'persistence' | 'orchestrator'>,
): TaskState[] {
  const { persistence, orchestrator } = deps;
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const nextGen = (workflow.generation ?? 0) + 1;
  persistence.updateWorkflow(workflowId, { generation: nextGen });
  console.log(`[workflow] bumped generation to ${nextGen} for ${workflowId}`);
  console.log(`[agent-session-trace] bumpGenerationAndRestart: calling restartWorkflow(${workflowId})`);
  return orchestrator.restartWorkflow(workflowId);
}

export async function approveTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): Promise<TaskState[]> {
  return deps.orchestrator.approve(taskId);
}

/**
 * Reject a task. Handles pendingFixError (from fix-with-claude) consistently
 * across all surfaces: if the task has a pending fix error, revert the
 * conflict resolution instead of rejecting outright.
 */
export function rejectTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  reason?: string,
): void {
  const task = deps.orchestrator.getTask(taskId);
  if (task?.execution.pendingFixError !== undefined) {
    deps.orchestrator.revertConflictResolution(taskId, task.execution.pendingFixError);
  } else {
    deps.orchestrator.reject(taskId, reason);
  }
}

export function provideInput(
  taskId: string,
  text: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): void {
  deps.orchestrator.provideInput(taskId, text);
}

export function restartTask(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.restartTask(taskId);
}

export function restartWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'persistence' | 'orchestrator'>,
): TaskState[] {
  return bumpGenerationAndRestart(workflowId, deps);
}

/**
 * Rebase-and-retry: refresh the pool mirror / origin base, remove managed
 * experiment/invoker branches in that mirror, bump generation, and restart the DAG.
 *
 * When `taskExecutor` is provided, `preparePoolForRebaseRetry` runs first; the
 * caller then executes runnable tasks (normal pool fetch + origin base resolution apply).
 */
export async function rebaseAndRetry(
  taskId: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const task = deps.orchestrator.getTask(taskId);
  if (!task?.config.workflowId) throw new Error(`Task ${taskId} not found or has no workflow`);
  const workflowId = task.config.workflowId;

  const workflow = deps.persistence.loadWorkflow(workflowId);
  console.log(
    `[agent-session-trace] rebaseAndRetry: taskId=${taskId} workflowId=${workflowId} → pool prep (if taskExecutor+repoUrl) → bumpGenerationAndRestart → restartWorkflow`,
  );
  if (deps.taskExecutor && workflow?.repoUrl) {
    await deps.taskExecutor.preparePoolForRebaseRetry(workflowId, workflow.repoUrl, workflow.baseBranch);
  }

  return bumpGenerationAndRestart(workflowId, deps);
}

export function editTaskCommand(
  taskId: string,
  newCommand: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskCommand(taskId, newCommand);
}

export function editTaskType(
  taskId: string,
  familiarType: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  remoteTargetId?: string,
): TaskState[] {
  return deps.orchestrator.editTaskType(taskId, familiarType, remoteTargetId);
}

export function selectExperiment(
  taskId: string,
  experimentId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.selectExperiment(taskId, experimentId);
}

export async function selectExperiments(
  taskId: string,
  ids: string[],
  deps: Pick<ActionDeps, 'orchestrator'> & { taskExecutor: TaskExecutor },
): Promise<TaskState[]> {
  if (ids.length === 1) {
    return deps.orchestrator.selectExperiment(taskId, ids[0]);
  }
  const { branch, commit } = await deps.taskExecutor.mergeExperimentBranches(taskId, ids);
  return deps.orchestrator.selectExperiments(taskId, ids, branch, commit);
}

/**
 * Merge-conflict resolution with Claude in the task worktree, then restart and execute.
 * Same sequence as GUI `invoker:resolve-conflict` and headless `resolve-conflict`.
 */
/**
 * Persist merge mode (normalizing `github` → `external_review`) and re-run the merge
 * gate when it was already finished or waiting, matching GUI `invoker:set-merge-mode`.
 */
export async function setWorkflowMergeMode(
  workflowId: string,
  mergeMode: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskExecutor },
): Promise<void> {
  const normalized = normalizeMergeModeForPersistence(mergeMode);
  deps.persistence.updateWorkflow(workflowId, { mergeMode: normalized });
  const tasks = deps.persistence.loadTasks(workflowId);
  const mergeTask = tasks.find((t) => t.config.isMergeNode);
  if (
    mergeTask &&
    (mergeTask.status === 'completed' || mergeTask.status === 'awaiting_approval')
  ) {
    const started = deps.orchestrator.restartTask(mergeTask.id);
    const runnable = started.filter((t) => t.status === 'running');
    await deps.taskExecutor.executeTasks(runnable);
  }
}

export async function resolveConflictWithClaudeAction(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskExecutor },
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const { savedError } = orchestrator.beginConflictResolution(taskId);
  try {
    await taskExecutor.resolveConflictWithClaude(taskId);
    const started = orchestrator.restartTask(taskId);
    const runnable = started.filter((t) => t.status === 'running');
    await taskExecutor.executeTasks(runnable);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    persistence.appendTaskOutput(taskId, `\n[Resolve Conflict] Failed: ${msg}`);
    orchestrator.revertConflictResolution(taskId, savedError, msg);
    throw err;
  }
}

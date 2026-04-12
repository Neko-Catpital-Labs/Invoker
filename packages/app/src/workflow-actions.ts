/**
 * Shared workflow action functions used by headless, GUI, and Slack surfaces.
 *
 * Each function performs an orchestrator mutation and returns TaskState[]
 * of affected tasks. The caller decides whether to executeTasks() and/or
 * waitForCompletion().
 */

import type { Logger } from '@invoker/contracts';
import type { Orchestrator, ExternalGatePolicyUpdate } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { TaskRunner } from '@invoker/execution-engine';
import { normalizeMergeModeForPersistence } from './merge-mode.js';

// ── Deps interfaces ──────────────────────────────────────────

export interface ActionDeps {
  logger?: Logger;
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  /** @deprecated Pool cleanup uses the workflow mirror; repoRoot branch deletion is no longer used. */
  repoRoot?: string;
  /** When set, rebase-and-refreshes the pool mirror and removes managed branches before bumping generation. */
  taskExecutor?: TaskRunner;
}

// ── Actions ──────────────────────────────────────────────────

export function bumpGenerationAndRecreate(
  workflowId: string,
  deps: Pick<ActionDeps, 'logger' | 'persistence' | 'orchestrator'>,
): TaskState[] {
  const { persistence, orchestrator } = deps;
  const workflow = persistence.loadWorkflow(workflowId);
  if (!workflow) throw new Error(`Workflow ${workflowId} not found`);
  const nextGen = (workflow.generation ?? 0) + 1;
  persistence.updateWorkflow(workflowId, { generation: nextGen });
  deps.logger?.info(`bumped generation to ${nextGen} for ${workflowId}`, { module: 'workflow' });
  deps.logger?.info(`bumpGenerationAndRecreate: calling recreateWorkflow(${workflowId})`, { module: 'agent-session-trace' });
  return orchestrator.recreateWorkflow(workflowId);
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

export function retryWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.retryWorkflow(workflowId);
}

export function recreateWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'logger' | 'persistence' | 'orchestrator'>,
): TaskState[] {
  return bumpGenerationAndRecreate(workflowId, deps);
}

export function recreateTask(
  taskId: string,
  deps: Pick<ActionDeps, 'persistence' | 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.recreateTask(taskId);
}

export function cancelWorkflow(
  workflowId: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): { cancelled: string[]; runningCancelled: string[] } {
  return deps.orchestrator.cancelWorkflow(workflowId);
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
  deps.logger?.info(
    `rebaseAndRetry: taskId=${taskId} workflowId=${workflowId} → pool prep (if taskExecutor+repoUrl) → bumpGenerationAndRecreate → recreateWorkflow`,
    { module: 'agent-session-trace' },
  );
  if (deps.taskExecutor && workflow?.repoUrl) {
    await deps.taskExecutor.preparePoolForRebaseRetry(workflowId, workflow.repoUrl, workflow.baseBranch);
  }

  return bumpGenerationAndRecreate(workflowId, deps);
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
  executorType: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
  remoteTargetId?: string,
): TaskState[] {
  return deps.orchestrator.editTaskType(taskId, executorType, remoteTargetId);
}

export function editTaskAgent(
  taskId: string,
  agentName: string,
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.editTaskAgent(taskId, agentName);
}

export function setTaskExternalGatePolicies(
  taskId: string,
  updates: ExternalGatePolicyUpdate[],
  deps: Pick<ActionDeps, 'orchestrator'>,
): TaskState[] {
  return deps.orchestrator.setTaskExternalGatePolicies(taskId, updates);
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
  deps: Pick<ActionDeps, 'orchestrator'> & { taskExecutor: TaskRunner },
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
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskRunner },
): Promise<void> {
  const normalized = normalizeMergeModeForPersistence(mergeMode);
  deps.persistence.updateWorkflow(workflowId, { mergeMode: normalized });
  const tasks = deps.persistence.loadTasks(workflowId);
  const mergeTask = tasks.find((t) => t.config.isMergeNode);
  if (
    mergeTask &&
    (mergeTask.status === 'completed' || mergeTask.status === 'awaiting_approval' || mergeTask.status === 'review_ready')
  ) {
    const started = deps.orchestrator.restartTask(mergeTask.id);
    const runnable = started.filter((t) => t.status === 'running');
    await deps.taskExecutor.executeTasks(runnable);
  }
}

export async function resolveConflictAction(
  taskId: string,
  deps: Pick<ActionDeps, 'orchestrator' | 'persistence'> & { taskExecutor: TaskRunner },
  agentName?: string,
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  const { savedError } = orchestrator.beginConflictResolution(taskId);
  try {
    await taskExecutor.resolveConflict(taskId, savedError, agentName);
    orchestrator.setFixAwaitingApproval(taskId, savedError);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    persistence.appendTaskOutput(taskId, `\n[Resolve Conflict] Failed: ${msg}`);
    orchestrator.revertConflictResolution(taskId, savedError, msg);
    throw err;
  }
}

// ── Auto-fix helpers ─────────────────────────────────────────

function isMergeConflictError(error: string): boolean {
  for (const c of [error, error.trim(), error.split('\n\n').at(-1)?.trim() ?? '']) {
    if (!c) continue;
    try { if ((JSON.parse(c) as any)?.type === 'merge_conflict') return true; } catch { /* not JSON */ }
  }
  return false;
}

/**
 * Automatically fix a failed task with an AI agent and restart it.
 * Increments autoFixAttempts; respects the max budget from shouldAutoFix().
 */
export async function autoFixOnFailure(
  taskId: string,
  deps: { orchestrator: Orchestrator; persistence: SQLiteAdapter; taskExecutor: TaskRunner },
): Promise<void> {
  const { orchestrator, persistence, taskExecutor } = deps;
  if (!orchestrator.shouldAutoFix(taskId)) return;

  const task = orchestrator.getTask(taskId);
  if (!task || task.status !== 'failed') return;

  const attempts = (task.execution.autoFixAttempts ?? 0) + 1;
  const max = task.config.autoFixRetries ?? 0;
  console.log(`[auto-fix] "${taskId}" attempt ${attempts}/${max}`);

  // Increment counter FIRST (before any delta can re-trigger)
  persistence.updateTask(taskId, { execution: { autoFixAttempts: attempts } });

  const { savedError } = orchestrator.beginConflictResolution(taskId);
  try {
    const output = persistence.getTaskOutput(taskId);
    if (isMergeConflictError(savedError)) {
      await taskExecutor.resolveConflict(taskId, savedError, 'claude');
    } else {
      await taskExecutor.fixWithAgent(taskId, output, 'claude', savedError);
    }
    // Skip approve flow — directly restart to re-run the task
    const started = orchestrator.restartTask(taskId);
    const runnable = started.filter(t => t.status === 'running');
    if (runnable.length > 0) await taskExecutor.executeTasks(runnable);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    persistence.appendTaskOutput(taskId, `\n[Auto-fix] Agent failed (attempt ${attempts}/${max}): ${msg}`);
    orchestrator.revertConflictResolution(taskId, savedError, msg);
  }
}

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
import { spawn } from 'node:child_process';

// ── Deps interfaces ──────────────────────────────────────────

export interface ActionDeps {
  orchestrator: Orchestrator;
  persistence: SQLiteAdapter;
  repoRoot?: string;
}

// ── Helpers ──────────────────────────────────────────────────

function execCommand(cmd: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('close', (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`${cmd} ${args.join(' ')} failed (code ${code}): ${stderr.trim()}`));
    });
  });
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
 * Rebase-and-retry: delete old task branches and recreate the entire workflow
 * from current HEAD.
 *
 * Previous implementation tried `git rebase` first, which was unreliable and
 * caused conflicts. The fix: always delete stale branches and do a full DAG
 * restart, so setupTaskBranch creates fresh branches from the latest HEAD.
 */
export async function rebaseAndRetry(
  taskId: string,
  deps: ActionDeps,
): Promise<TaskState[]> {
  const task = deps.orchestrator.getTask(taskId);
  if (!task?.config.workflowId) throw new Error(`Task ${taskId} not found or has no workflow`);
  const workflowId = task.config.workflowId;

  // Delete old task branches so setupTaskBranch creates fresh ones from current HEAD
  const workflowTasks = deps.orchestrator.getAllTasks().filter(
    t => t.config.workflowId === workflowId && !t.config.isMergeNode,
  );
  for (const t of workflowTasks) {
    const branch = t.execution.branch ?? `invoker/${t.id}`;
    try {
      await execCommand('git', ['branch', '-D', branch], deps.repoRoot!);
      console.log(`Deleted old branch: ${branch}`);
    } catch { /* branch may not exist */ }
  }

  // Always recreate workflow on current HEAD — no git rebase
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
): TaskState[] {
  return deps.orchestrator.editTaskType(taskId, familiarType);
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

/**
 * TaskStateMachine — Pure, immutable task state management.
 *
 * Every mutation returns a TransitionResult with the new state, a delta
 * for the UI, and any side effects (ready tasks, blocked tasks).
 * No EventEmitter, no I/O, no persistence — callers handle those.
 *
 * Storage is delegated to ActionGraph. This class owns transitions only.
 */

import type {
  TaskState,
  TaskStatus,
  TaskDelta,
  TaskTransition,
  SideEffect,
  TransitionResult,
  TaskCreateOptions,
  ExperimentResultEntry,
} from './task-types.js';
import { ActionGraph } from '@invoker/graph';

export interface CreateResult {
  readonly task: TaskState;
  readonly delta: TaskDelta;
}

export class TaskStateMachine {
  constructor(private readonly graph: ActionGraph = new ActionGraph()) {}

  // ── Queries ─────────────────────────────────────────────

  getTask(id: string): TaskState | undefined {
    return this.graph.getNode(id);
  }

  getAllTasks(): TaskState[] {
    return this.graph.getAllNodes();
  }

  getTaskCount(): number {
    return this.graph.getNodeCount();
  }

  /**
   * Returns pending tasks whose dependencies are ALL completed.
   */
  getReadyTasks(): TaskState[] {
    return this.graph.getReadyNodes();
  }

  // ── Restore ─────────────────────────────────────────────

  /**
   * Insert a task directly into the internal map without producing a delta.
   * Used when resuming a workflow from persistence.
   */
  restoreTask(task: TaskState): void {
    this.graph.restoreNode(task);
  }

  // ── Create ──────────────────────────────────────────────

  createTask(
    id: string,
    description: string,
    dependencies: string[],
    options: TaskCreateOptions = {},
  ): CreateResult {
    const { node, delta } = this.graph.createNode(id, description, dependencies, options);
    return { task: node, delta };
  }

  // ── Transitions ─────────────────────────────────────────

  startTask(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'pending') {
      return { error: `Cannot start task ${taskId}: status is '${task.status}', expected 'pending'` };
    }

    return this.transition(task, 'running', { startedAt: new Date() });
  }

  completeTask(taskId: string, exitCode: number = 0, summary?: string, commitHash?: string, claudeSessionId?: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'running' && task.status !== 'awaiting_approval') {
      return { error: `Cannot complete task ${taskId}: status is '${task.status}'` };
    }

    const result = this.transition(task, 'completed', {
      exitCode,
      completedAt: new Date(),
      summary,
      commit: commitHash,
      claudeSessionId,
    });

    // Find newly ready dependents
    const readyTasks = this.findNewlyReadyTasks(taskId);
    if (readyTasks.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_ready', taskIds: readyTasks } as const,
      ];
    }

    return result;
  }

  failTask(taskId: string, exitCode: number = 1, error?: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'running' && task.status !== 'awaiting_approval') {
      return { error: `Cannot fail task ${taskId}: status is '${task.status}'` };
    }

    const result = this.transition(task, 'failed', {
      exitCode,
      error,
      completedAt: new Date(),
    });

    // Block all transitive dependents
    const blockedIds = this.blockDependentTasks(taskId);
    if (blockedIds.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_blocked', taskIds: blockedIds, blockedBy: taskId } as const,
      ];
    }

    return result;
  }

  pauseForInput(taskId: string, prompt: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'running') {
      return { error: `Cannot pause task ${taskId}: status is '${task.status}', expected 'running'` };
    }

    return this.transition(task, 'needs_input', { inputPrompt: prompt });
  }

  resumeWithInput(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'needs_input') {
      return { error: `Cannot resume task ${taskId}: status is '${task.status}', expected 'needs_input'` };
    }

    return this.transition(task, 'running', { inputPrompt: undefined });
  }

  requestApproval(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'running') {
      return { error: `Cannot request approval for task ${taskId}: status is '${task.status}'` };
    }

    return this.transition(task, 'awaiting_approval', {});
  }

  approveTask(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'awaiting_approval') {
      return { error: `Cannot approve task ${taskId}: status is '${task.status}'` };
    }

    const result = this.transition(task, 'completed', { completedAt: new Date() });

    const readyTasks = this.findNewlyReadyTasks(taskId);
    if (readyTasks.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_ready', taskIds: readyTasks } as const,
      ];
    }

    return result;
  }

  rejectTask(taskId: string, error?: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'awaiting_approval') {
      return { error: `Cannot reject task ${taskId}: status is '${task.status}'` };
    }

    const result = this.transition(task, 'failed', {
      error: error ?? 'Rejected by user',
      completedAt: new Date(),
    });

    const blockedIds = this.blockDependentTasks(taskId);
    if (blockedIds.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_blocked', taskIds: blockedIds, blockedBy: taskId } as const,
      ];
    }

    return result;
  }

  // ── Reconciliation ──────────────────────────────────────

  triggerReconciliation(
    taskId: string,
    experimentResults: ExperimentResultEntry[],
  ): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (!task.isReconciliation) {
      return { error: `Task ${taskId} is not a reconciliation task` };
    }

    return this.transition(task, 'needs_input', {
      experimentResults,
    });
  }

  completeReconciliation(
    taskId: string,
    selectedExperimentId: string,
  ): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'needs_input' || !task.isReconciliation) {
      return { error: `Cannot complete reconciliation for task ${taskId}` };
    }

    const result = this.transition(task, 'completed', {
      selectedExperiment: selectedExperimentId,
      completedAt: new Date(),
    });

    const readyTasks = this.findNewlyReadyTasks(taskId);
    if (readyTasks.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_ready', taskIds: readyTasks } as const,
      ];
    }

    return result;
  }

  // ── Stale (dirty detection) ────────────────────────────

  /**
   * Mark a completed or failed task as stale (invalidated by upstream mutation).
   * Only valid from terminal states: completed, failed, blocked.
   */
  markStale(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'blocked') {
      return { error: `Cannot mark task ${taskId} as stale: status is '${task.status}', expected 'completed', 'failed', or 'blocked'` };
    }

    return this.transition(task, 'stale', {});
  }

  // ── DAG Mutations ───────────────────────────────────────

  /**
   * Rewrite dependencies: replace oldDepId with newDepId in all tasks
   * that depend on oldDepId. Skips experiment children of the old dep.
   */
  rewriteDependency(oldDepId: string, newDepId: string): TaskDelta[] {
    return this.graph.rewriteDependency(oldDepId, newDepId);
  }

  // ── Restart ────────────────────────────────────────────

  /**
   * Reset a non-running task back to pending.
   * Clears execution artifacts and unblocks transitive dependents.
   */
  restartTask(taskId: string): TransitionResult | { error: string } {
    const task = this.graph.getNode(taskId);
    if (!task) return { error: `Task ${taskId} not found` };
    if (task.status === 'running') {
      return { error: `Cannot restart task ${taskId}: it is currently running` };
    }

    const result = this.transition(task, 'pending', {
      startedAt: undefined,
      completedAt: undefined,
      error: undefined,
      exitCode: undefined,
      blockedBy: undefined,
      summary: undefined,
      commit: undefined,
    });

    // Unblock transitive dependents that were blocked by this task
    const unblockedIds = this.unblockDependentTasks(taskId);
    if (unblockedIds.length > 0) {
      result.sideEffects = [
        ...result.sideEffects,
        { type: 'tasks_ready', taskIds: unblockedIds } as const,
      ];
    }

    return result;
  }

  // ── Cleanup ─────────────────────────────────────────────

  clear(): void {
    this.graph.clear();
  }

  removeTask(taskId: string): boolean {
    return this.graph.removeNode(taskId);
  }

  // ── Private Helpers ─────────────────────────────────────

  private transition(
    task: TaskState,
    to: TaskStatus,
    changes: Partial<TaskState>,
  ): TransitionResult & { sideEffects: SideEffect[] } {
    const updated: TaskState = { ...task, status: to, ...changes };
    this.graph.setNode(task.id, updated);

    return {
      task: updated,
      delta: { type: 'updated', taskId: task.id, changes: { status: to, ...changes } },
      transition: { from: task.status, to, taskId: task.id, timestamp: new Date() },
      sideEffects: [],
    };
  }

  /**
   * Find pending tasks that just became ready because taskId completed.
   */
  private findNewlyReadyTasks(completedTaskId: string): string[] {
    const ready: string[] = [];

    for (const task of this.graph.getAllNodes()) {
      if (task.status !== 'pending') continue;
      if (!task.dependencies.includes(completedTaskId)) continue;

      const allDepsComplete = task.dependencies.every((depId) => {
        const dep = this.graph.getNode(depId);
        return dep?.status === 'completed';
      });

      if (allDepsComplete) {
        ready.push(task.id);
      }
    }

    return ready;
  }

  /**
   * Unblock tasks that were blocked by the given task.
   * Resets them to pending so they can be re-evaluated.
   */
  private unblockDependentTasks(taskId: string): string[] {
    const unblocked: string[] = [];

    for (const task of this.graph.getAllNodes()) {
      if (task.status !== 'blocked') continue;
      if (task.blockedBy !== taskId) continue;

      const updated: TaskState = {
        ...task,
        status: 'pending' as const,
        blockedBy: undefined,
      };
      this.graph.setNode(task.id, updated);
      unblocked.push(task.id);
    }

    return unblocked;
  }

  /**
   * Block all tasks that transitively depend on a failed task.
   * Uses BFS to find all downstream dependents.
   */
  private blockDependentTasks(failedTaskId: string): string[] {
    const blocked: string[] = [];
    const queue = [failedTaskId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      // Find all tasks that depend on currentId
      for (const task of this.graph.getAllNodes()) {
        if (task.status !== 'pending' && task.status !== 'blocked') continue;
        if (!task.dependencies.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        const updated: TaskState = {
          ...task,
          status: 'blocked' as const,
          blockedBy: failedTaskId,
        };
        this.graph.setNode(task.id, updated);
        blocked.push(task.id);
        queue.push(task.id); // Continue BFS for transitive dependents
      }
    }

    return blocked;
  }
}

/**
 * TaskStateMachine — Read-only query layer over the in-memory task graph.
 *
 * The graph is populated exclusively via `restoreTask()` / `clear()` during
 * DB sync. This class provides graph-aware queries (dependency resolution,
 * blocking analysis) but never mutates the graph directly.
 *
 * All writes go through the persistence layer; the Orchestrator coordinates
 * write → DB → sync → query cycles.
 */

import type { TaskState } from './task-types.js';
import { ActionGraph } from '@invoker/graph';

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

  // ── Graph Queries (read-only) ──────────────────────────

  /**
   * Find pending tasks that just became ready because `completedTaskId`
   * was marked completed. Reads from the graph — caller must ensure the
   * completed task is already synced in the graph before calling.
   */
  findNewlyReadyTasks(completedTaskId: string): string[] {
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
   * Compute all tasks that should be blocked when `failedTaskId` fails.
   * Returns transitive dependents (BFS) that are pending or blocked.
   * Does NOT mutate the graph — returns IDs only.
   */
  computeTasksToBlock(failedTaskId: string): string[] {
    const blocked: string[] = [];
    const queue = [failedTaskId];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const currentId = queue.shift()!;
      if (visited.has(currentId)) continue;
      visited.add(currentId);

      for (const task of this.graph.getAllNodes()) {
        if (task.status !== 'pending' && task.status !== 'blocked') continue;
        if (!task.dependencies.includes(currentId)) continue;
        if (visited.has(task.id)) continue;

        blocked.push(task.id);
        queue.push(task.id);
      }
    }

    return blocked;
  }

  /**
   * Compute tasks that should be unblocked when `taskId` is restarted.
   * Returns IDs of tasks currently blocked by `taskId`.
   * Does NOT mutate the graph — returns IDs only.
   */
  computeTasksToUnblock(taskId: string): string[] {
    const unblocked: string[] = [];

    for (const task of this.graph.getAllNodes()) {
      if (task.status !== 'blocked') continue;
      if (task.blockedBy !== taskId) continue;
      unblocked.push(task.id);
    }

    return unblocked;
  }

  // ── Sync (only way to write to graph) ──────────────────

  /**
   * Insert a task directly into the graph without producing a delta.
   * Used when syncing from the database (the single source of truth).
   */
  restoreTask(task: TaskState): void {
    this.graph.restoreNode(task);
  }

  /** Clear all tasks. Used before a full DB re-sync. */
  clear(): void {
    this.graph.clear();
  }
}

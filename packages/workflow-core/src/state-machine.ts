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

import type { TaskState } from '@invoker/workflow-graph';
import { ActionGraph } from '@invoker/workflow-graph';

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
   * was marked completed or failed. Reads from the graph — caller must ensure the
   * completed task is already synced in the graph before calling.
   *
   * Reconciliation tasks depend on experiment nodes that may end in `failed`; those
   * deps still count as settled for readiness.
   */
  findNewlyReadyTasks(completedTaskId: string): string[] {
    const ready: string[] = [];

    for (const task of this.graph.getAllNodes()) {
      // Log merge nodes specifically to trace why they're skipped/included
      if (task.config?.isMergeNode) {
        const depStatuses = task.dependencies.map(depId => {
          const dep = this.graph.getNode(depId);
          return `${depId}=${dep?.status ?? 'NOT_FOUND'}`;
        });
        console.log(`[state-machine] findNewlyReadyTasks(${completedTaskId}): merge node "${task.id}" status=${task.status} deps=[${depStatuses.join(', ')}] hasDep=${task.dependencies.includes(completedTaskId)}`);
      }

      if (task.status !== 'pending' && task.status !== 'blocked') continue;
      if (!task.dependencies.includes(completedTaskId)) continue;

      const allDepsComplete = task.dependencies.every((depId) => {
        const dep = this.graph.getNode(depId);
        if (!dep) return false;
        if (task.config?.isReconciliation) {
          return (
            dep.status === 'completed' ||
            dep.status === 'failed' ||
            dep.status === 'stale'
          );
        }
        return dep.status === 'completed' || dep.status === 'stale';
      });

      if (allDepsComplete) {
        ready.push(task.id);
      }
    }

    return ready;
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

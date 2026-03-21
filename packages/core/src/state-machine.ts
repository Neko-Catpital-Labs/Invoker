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
        return dep?.status === 'completed' || dep?.status === 'stale';
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

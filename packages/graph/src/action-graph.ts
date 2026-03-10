import type { TaskState, TaskCreateOptions, TaskDelta } from './types.js';
import { createTaskState } from './types.js';

export interface CreateNodeResult {
  readonly node: TaskState;
  readonly delta: TaskDelta;
}

/**
 * ActionGraph — owns the node Map and provides storage, query, and DAG mutation.
 *
 * No state transitions, no side effects, no event emission.
 * The StateMachine/Evaluator layer handles those concerns.
 */
export class ActionGraph {
  private nodes: Map<string, TaskState> = new Map();

  // ── Queries ─────────────────────────────────────────────

  getNode(id: string): TaskState | undefined {
    return this.nodes.get(id);
  }

  getAllNodes(): TaskState[] {
    return Array.from(this.nodes.values());
  }

  getNodeCount(): number {
    return this.nodes.size;
  }

  /**
   * Returns pending nodes whose dependencies are ALL completed.
   */
  getReadyNodes(): TaskState[] {
    return Array.from(this.nodes.values()).filter((node) => {
      if (node.status !== 'pending') return false;
      return node.dependencies.every((depId) => {
        const dep = this.nodes.get(depId);
        return dep?.status === 'completed';
      });
    });
  }

  // ── Restore ─────────────────────────────────────────────

  /**
   * Insert a node directly without producing a delta.
   * Used when resuming a workflow from persistence.
   */
  restoreNode(node: TaskState): void {
    this.nodes.set(node.id, node);
  }

  // ── Create ──────────────────────────────────────────────

  createNode(
    id: string,
    description: string,
    dependencies: string[],
    options: TaskCreateOptions = {},
  ): CreateNodeResult {
    const node = createTaskState(id, description, dependencies, options);

    // Check if any dependency has already failed → start as blocked
    const failedDep = dependencies.find((depId) => {
      const dep = this.nodes.get(depId);
      return dep?.status === 'failed';
    });

    const finalNode: TaskState = failedDep
      ? { ...node, status: 'blocked' as const, blockedBy: failedDep }
      : node;

    this.nodes.set(id, finalNode);

    return {
      node: finalNode,
      delta: { type: 'created', task: finalNode },
    };
  }

  // ── DAG Mutation ────────────────────────────────────────

  /**
   * Rewrite dependencies: replace oldDepId with newDepId in all nodes
   * that depend on oldDepId. Skips experiment children of the old dep.
   */
  rewriteDependency(oldDepId: string, newDepId: string): TaskDelta[] {
    const deltas: TaskDelta[] = [];

    for (const [id, node] of this.nodes) {
      if (!node.dependencies.includes(oldDepId)) continue;
      // Skip experiment children (they depend on parent, not reconciliation)
      if (node.parentTask === oldDepId) continue;

      const newDeps = node.dependencies.map((d) => (d === oldDepId ? newDepId : d));
      const updated: TaskState = { ...node, dependencies: newDeps };
      this.nodes.set(id, updated);
      deltas.push({ type: 'updated', taskId: id, changes: { dependencies: newDeps } });
    }

    return deltas;
  }

  // ── Internal Mutation ───────────────────────────────────

  /**
   * Set a node directly. Used by the StateMachine/Evaluator
   * to update node state after transitions.
   */
  setNode(id: string, node: TaskState): void {
    this.nodes.set(id, node);
  }

  // ── Cleanup ─────────────────────────────────────────────

  removeNode(id: string): boolean {
    return this.nodes.delete(id);
  }

  clear(): void {
    this.nodes.clear();
  }
}

import type { TaskState } from './types.js';

/**
 * ActionGraph — read-only in-memory cache of task state.
 *
 * The graph is populated exclusively via `restoreNode()` (called during
 * DB sync). All writes go through the persistence layer; this class
 * provides fast in-memory reads and graph queries only.
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

  // ── Sync (only way to write) ───────────────────────────

  /**
   * Insert a node directly without producing a delta.
   * Used when syncing from the database (the single source of truth).
   */
  restoreNode(node: TaskState): void {
    this.nodes.set(node.id, node);
  }

  /** Clear all nodes. Used before a full DB re-sync. */
  clear(): void {
    this.nodes.clear();
  }
}

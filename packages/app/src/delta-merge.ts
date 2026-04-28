/**
 * Task-state-version-aware delta-merge logic for the main-process task
 * snapshot cache.
 *
 * The cache tracks the last emitted snapshot, its taskStateVersion, and whether a
 * task is quarantined for recovery.  `updated` deltas only merge when
 * `previousTaskStateVersion` matches the cached taskStateVersion; unknown
 * tasks or task-state-version gaps quarantine the task and trigger
 * authoritative reload by id.
 * Deltas for quarantined tasks are ignored until recovery finishes.
 */
import type { TaskDelta, TaskState } from '@invoker/workflow-core';

// ── Cache entry ──────────────────────────────────────────────

export interface CacheEntry {
  snapshot: string;
  taskStateVersion: number;
  quarantined: boolean;
}

// ── Authoritative loader (persistence by id) ────────────────

export interface AuthoritativeTaskLoader {
  loadTask(taskId: string): TaskState | undefined;
}

// ── Snapshot cache ───────────────────────────────────────────

/**
 * Task-state-version-aware wrapper around the task snapshot map.
 *
 * Direct setters (`set`, `clear`, `delete`, `keys`) are exposed so
 * existing call sites in main.ts that bulk-seed the cache continue to
 * work unchanged.  The gap-detection logic lives in `applyDelta`.
 */
export class TaskSnapshotCache {
  private readonly entries = new Map<string, CacheEntry>();

  // ── Bulk operations (used by seedUiSnapshotCache, db-poll, etc.) ──

  set(taskId: string, snapshot: string): void {
    const task: TaskState = JSON.parse(snapshot);
    this.entries.set(taskId, {
      snapshot,
      taskStateVersion: task.taskStateVersion ?? 1,
      quarantined: false,
    });
  }

  get(taskId: string): string | undefined {
    const entry = this.entries.get(taskId);
    return entry?.snapshot;
  }

  has(taskId: string): boolean {
    return this.entries.has(taskId);
  }

  delete(taskId: string): boolean {
    return this.entries.delete(taskId);
  }

  clear(): void {
    this.entries.clear();
  }

  keys(): IterableIterator<string> {
    return this.entries.keys();
  }

  /** Expose the raw entry for testing / inspection. */
  getEntry(taskId: string): CacheEntry | undefined {
    return this.entries.get(taskId);
  }

  isQuarantined(taskId: string): boolean {
    return this.entries.get(taskId)?.quarantined === true;
  }
}

// ── Delta application ────────────────────────────────────────

export interface ApplyDeltaResult {
  /** Task IDs that need authoritative reload from persistence. */
  quarantined: string[];
}

/**
 * Apply a single TaskDelta to the snapshot cache.
 *
 * Task-state-version-aware semantics:
 * - `created`: unconditionally stores the task snapshot and taskStateVersion.
 * - `updated` with matching `previousTaskStateVersion`: merges changes, bumps
 *   the cached taskStateVersion to `delta.taskStateVersion`.
 * - `updated` with a taskStateVersion gap or unknown task: quarantines the task
 *   and returns its id in `result.quarantined`.
 * - `removed`: deletes the cache entry.
 * - Deltas targeting a quarantined task are silently ignored.
 *
 * @returns IDs of tasks that were quarantined and need authoritative reload.
 */
export function applyDelta(
  delta: TaskDelta,
  cache: TaskSnapshotCache,
): ApplyDeltaResult {
  const result: ApplyDeltaResult = { quarantined: [] };

  if (delta.type === 'created') {
    cache.set(delta.task.id, JSON.stringify(delta.task));
    return result;
  }

  if (delta.type === 'removed') {
    cache.delete(delta.taskId);
    return result;
  }

  // delta.type === 'updated'
  const entry = cache.getEntry(delta.taskId);

  // Quarantined tasks: ignore until recovery completes.
  if (entry?.quarantined) {
    return result;
  }

  // Unknown task or taskStateVersion gap → quarantine.
  if (!entry || entry.taskStateVersion !== delta.previousTaskStateVersion) {
    // Mark as quarantined.  If the entry exists, keep its snapshot but
    // flag it; if it doesn't, create a placeholder entry.
    if (entry) {
      entry.quarantined = true;
    }
    result.quarantined.push(delta.taskId);
    return result;
  }

  // Task-state version matches — apply the merge.
  const prev: TaskState = JSON.parse(entry.snapshot);
  const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
  const merged = {
    ...prev,
    ...topLevel,
    taskStateVersion: delta.taskStateVersion,
    config: { ...prev.config, ...cfgChanges },
    execution: { ...prev.execution, ...execChanges },
  };
  const snapshot = JSON.stringify(merged);
  // Update the entry in-place to avoid extra map operations.
  entry.snapshot = snapshot;
  entry.taskStateVersion = delta.taskStateVersion;

  return result;
}

/**
 * Complete recovery for a quarantined task by replacing the cache entry
 * with the authoritative snapshot from persistence.
 *
 * If `task` is undefined (task no longer exists), the cache entry is removed.
 */
export function resolveQuarantine(
  cache: TaskSnapshotCache,
  taskId: string,
  task: TaskState | undefined,
): void {
  if (!task) {
    cache.delete(taskId);
    return;
  }
  cache.set(taskId, JSON.stringify(task));
}

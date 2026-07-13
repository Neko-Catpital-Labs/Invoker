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

type SnapshotTaskState = Omit<TaskState, 'taskStateVersion'> & {
  taskStateVersion?: number;
};

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
    const task = JSON.parse(snapshot) as SnapshotTaskState;
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
  /** True when the original delta is current and safe to forward to the renderer. */
  accepted: boolean;
}

/**
 * Apply a single TaskDelta to the snapshot cache.
 *
 * Task-state-version-aware semantics:
 * - `created`: stores new task snapshots, but rejects stale snapshots that
 *   would downgrade an existing cache entry.
 * - `updated` with matching `previousTaskStateVersion`: merges changes, bumps
 *   the cached taskStateVersion to `delta.taskStateVersion`.
 * - `updated` with a forward taskStateVersion gap or unknown task: quarantines
 *   the task and returns its id in `result.quarantined`.
 * - `updated` at or behind the cached taskStateVersion is stale and ignored.
 * - `removed`: deletes the cache entry unless the remove is stale.
 * - Deltas targeting a quarantined task are silently ignored.
 *
 * @returns IDs of tasks that were quarantined and whether the original delta was accepted.
 */
export function applyDelta(
  delta: TaskDelta,
  cache: TaskSnapshotCache,
): ApplyDeltaResult {
  const result: ApplyDeltaResult = { quarantined: [], accepted: false };

  if (delta.type === 'created') {
    const entry = cache.getEntry(delta.task.id);
    const nextVersion = delta.task.taskStateVersion ?? 1;
    if (entry && nextVersion < entry.taskStateVersion) {
      return result;
    }

    cache.set(delta.task.id, JSON.stringify(delta.task));
    return { quarantined: [], accepted: true };
  }

  if (delta.type === 'removed') {
    const entry = cache.getEntry(delta.taskId);
    if (entry && delta.previousTaskStateVersion < entry.taskStateVersion) {
      return result;
    }

    cache.delete(delta.taskId);
    return { quarantined: [], accepted: true };
  }

  // delta.type === 'updated'
  const entry = cache.getEntry(delta.taskId);

  // Quarantined tasks: ignore until recovery completes.
  if (entry?.quarantined) {
    return result;
  }

  // Unknown task → quarantine so persistence can tell the renderer to create
  // or remove the task authoritatively.
  if (!entry) {
    result.quarantined.push(delta.taskId);
    return result;
  }

  // Stale/backward delta → drop without quarantining or mutating cache.
  if (delta.taskStateVersion <= entry.taskStateVersion) {
    return result;
  }

  // Forward gap → quarantine. Keep the cached snapshot but block later deltas
  // until recovery replaces or removes it.
  if (entry.taskStateVersion !== delta.previousTaskStateVersion) {
    entry.quarantined = true;
    result.quarantined.push(delta.taskId);
    return result;
  }

  // Task-state version matches — apply the merge.
  const prev = JSON.parse(entry.snapshot) as SnapshotTaskState;
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

  return { quarantined: [], accepted: true };
}

/**
 * Complete recovery for a quarantined task by replacing the cache entry
 * with the authoritative snapshot from persistence.
 *
 * If `task` is undefined (task no longer exists), the cache entry is removed.
 *
 * NOTE: this primitive is intentionally low-level — it does NOT notify the
 * renderer. Production callers should go through `recoverQuarantinedTask`
 * below, which enforces the "no implicit message drops" rule by always
 * returning a renderer delta whenever it mutates the owner cache.
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

// ── Authoritative recovery (no implicit message drops) ──────

/**
 * Loaders the recovery loop consults to find an authoritative snapshot
 * for a quarantined task id.
 *
 * - `loadTask`: persistence by id. Returns `undefined` for ids that have
 *   never been persisted (notably synthetic merge nodes).
 * - `getMergeNode`: orchestrator in-memory lookup by workflowId. Authoritative
 *   source for synthetic `__merge__${workflowId}` ids, which are not stored
 *   in persistence but are tracked in `Orchestrator.stateMachine`.
 */
export interface RecoveryLoaders {
  loadTask: (taskId: string) => TaskState | undefined;
  getMergeNode: (workflowId: string) => TaskState | undefined;
}

export interface RecoveryResult {
  /**
   * Renderer-bound delta the caller MUST forward to keep the renderer in
   * sync with the owner cache. `undefined` only when no cache mutation
   * happened (currently never — every branch either restores from an
   * authoritative source or emits `removed`).
   */
  rendererDelta?: TaskDelta;
}

const SYNTHETIC_MERGE_PREFIX = '__merge__';

/**
 * Single source of truth for the main-process quarantine-recovery loop.
 *
 * Contract — no implicit message drops:
 * - If persistence has the task → restore from persistence, emit `created`.
 * - Else if it's a synthetic merge id and the orchestrator has it in memory
 *   → restore from orchestrator, emit `created`.
 * - Else (truly absent) → delete the cache entry, emit `removed` so the
 *   renderer drops its stale copy too.
 *
 * This replaces the legacy `if (authoritative) { sendTaskDeltaToRenderer(...) }`
 * pattern that silently dropped the recovery message whenever
 * `loadTask` returned `undefined`. For synthetic merge nodes that path
 * never produced a recovery delta, leaving the renderer's selected
 * mini-DAG blank after every `[gap-detect]` event.
 */
export function recoverQuarantinedTask(
  cache: TaskSnapshotCache,
  taskId: string,
  loaders: RecoveryLoaders,
): RecoveryResult {
  const persisted = loaders.loadTask(taskId);
  if (persisted) {
    resolveQuarantine(cache, taskId, persisted);
    return { rendererDelta: { type: 'created', task: persisted } };
  }

  if (taskId.startsWith(SYNTHETIC_MERGE_PREFIX)) {
    const workflowId = taskId.slice(SYNTHETIC_MERGE_PREFIX.length);
    const synthetic = loaders.getMergeNode(workflowId);
    if (synthetic) {
      resolveQuarantine(cache, taskId, synthetic);
      return { rendererDelta: { type: 'created', task: synthetic } };
    }
  }

  const previousTaskStateVersion = cache.getEntry(taskId)?.taskStateVersion ?? 0;
  resolveQuarantine(cache, taskId, undefined);
  return {
    rendererDelta: { type: 'removed', taskId, previousTaskStateVersion },
  };
}

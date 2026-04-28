/**
 * Revision-aware delta application for the renderer task map.
 *
 * Delta types:
 * - created: unconditionally sets the task (authoritative replacement).
 *   After main-process gap recovery, the main process sends a `created`
 *   delta with the authoritative snapshot — the renderer must overwrite
 *   any stale local state.
 * - updated: merges changes only when `previousRevision` matches the
 *   local task revision.  On mismatch or unknown task, the task is
 *   quarantined (deltas are dropped until an authoritative `created`
 *   delta arrives from the main process).
 * - removed: deletes the task and clears quarantine state.
 */

import type { TaskState, TaskDelta } from '../types.js';

export interface ApplyDeltaResult {
  tasks: Map<string, TaskState>;
  /** Task IDs that were quarantined due to revision gaps. */
  quarantined: string[];
}

/**
 * Apply a single delta to the task map with revision validation.
 *
 * The `quarantinedIds` set tracks tasks awaiting authoritative recovery.
 * Callers must maintain this set across calls; `created` deltas clear
 * quarantine, `updated` deltas with revision gaps add to it.
 */
export function applyDelta(
  tasks: Map<string, TaskState>,
  delta: TaskDelta,
  quarantinedIds: Set<string>,
): ApplyDeltaResult {
  const next = new Map(tasks);
  const result: ApplyDeltaResult = { tasks: next, quarantined: [] };

  switch (delta.type) {
    case 'created':
      // Authoritative replacement: always overwrite, clear quarantine.
      next.set(delta.task.id, delta.task);
      quarantinedIds.delete(delta.task.id);
      break;

    case 'updated': {
      const taskId = delta.taskId;

      // Quarantined: drop deltas until authoritative recovery arrives.
      if (quarantinedIds.has(taskId)) {
        break;
      }

      const existing = next.get(taskId);

      if (!existing || existing.revision !== delta.previousRevision) {
        // Revision gap or unknown task — quarantine.
        quarantinedIds.add(taskId);
        result.quarantined.push(taskId);
        break;
      }

      // Revision matches — apply incremental merge.
      const { config: cfgChanges, execution: execChanges, ...topLevel } = delta.changes;
      next.set(taskId, {
        ...existing,
        ...topLevel,
        revision: delta.revision,
        config: { ...existing.config, ...cfgChanges },
        execution: { ...existing.execution, ...execChanges },
      });
      break;
    }

    case 'removed':
      next.delete(delta.taskId);
      quarantinedIds.delete(delta.taskId);
      break;
  }

  return result;
}

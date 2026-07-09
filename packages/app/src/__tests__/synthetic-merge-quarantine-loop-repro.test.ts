/**
 * Repro + regression guard for the synthetic `__merge__wf-…` quarantine-loop
 * desync that blanks the graph UI.
 *
 * Real-world symptom: bursts of `[gap-detect] quarantined task="__merge__wf-X"`
 * lines in ~/.invoker/invoker.log with no intervening recovery, after which
 * the selected workflow's mini-DAG renders blank until the user reloads.
 *
 * Owner-side root cause (current production code at
 * packages/app/src/main.ts:2896–2904):
 *
 *   const { quarantined } = applyDelta(d, lastKnownTaskStates);
 *   for (const taskId of quarantined) {
 *     const authoritative = loadTaskByIdFromPersistence(taskId);
 *     resolveQuarantine(lastKnownTaskStates, taskId, authoritative);
 *     if (authoritative) {
 *       sendTaskDeltaToRenderer({ type: 'created', task: authoritative });
 *     }
 *   }
 *
 * For synthetic merge ids (`__merge__${workflowId}`) persistence has no
 * record, so `authoritative === undefined`. `resolveQuarantine` silently
 * deletes the owner cache entry and the renderer is told nothing. The next
 * `updated` delta on the same id re-quarantines (unknown task branch in
 * applyDelta) and the loop repeats indefinitely. The renderer keeps its
 * stale snapshot for the merge node while the owner has erased it; when
 * `workflows-changed` next reconciles, the selected workflow disappears.
 *
 * The fix introduces `recoverQuarantinedTask` in delta-merge.ts (with the
 * "no implicit message drops" contract: every cache deletion is mirrored
 * to the renderer via either `created` or `removed`). This file pins the
 * four post-fix expectations as a permanent regression guard. Reverting
 * the fix re-fails all four cases with the same diff shape as the
 * original Phase 1 reproduction.
 */
import { describe, it, expect } from 'vitest';
import {
  applyDelta,
  recoverQuarantinedTask,
  TaskSnapshotCache,
  type RecoveryLoaders,
} from '../delta-merge.js';
import type { TaskState, TaskDelta } from '@invoker/workflow-core';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'running',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: { workflowId: 'wf-1', command: `echo ${id}`, runnerKind: 'worktree' as const },
    execution: {},
    taskStateVersion: 1,
    ...overrides,
  } as TaskState;
}

function makeMergeNode(workflowId: string, taskStateVersion: number): TaskState {
  return makeTask(`__merge__${workflowId}`, {
    taskStateVersion,
    config: {
      workflowId,
      command: 'noop',
      runnerKind: 'worktree' as const,
      isMergeNode: true,
    },
  });
}

/**
 * Faithful mirror of the production main-process recovery loop
 * (packages/app/src/main.ts:2896–2906): apply the delta, then for each
 * quarantined id, run the shared `recoverQuarantinedTask` helper and
 * collect every renderer delta it returns.
 *
 * Pre-fix, this file used a `simulateLegacyRecoveryLoop` that inlined the
 * old buggy code (no orchestrator fallback, silent delete on persistence
 * miss). Post-fix it calls the real helper so the assertions below act as
 * a permanent regression guard.
 */
function runRecovery(
  delta: TaskDelta,
  cache: TaskSnapshotCache,
  loaders: RecoveryLoaders,
): { rendererDeltas: TaskDelta[] } {
  const rendererDeltas: TaskDelta[] = [];
  const { quarantined, accepted } = applyDelta(delta, cache);
  if (quarantined.length === 0 && accepted) {
    rendererDeltas.push(delta);
  }
  for (const taskId of quarantined) {
    const { rendererDelta } = recoverQuarantinedTask(cache, taskId, loaders);
    if (rendererDelta) {
      rendererDeltas.push(rendererDelta);
    }
  }
  return { rendererDeltas };
}

// ── Fixtures ────────────────────────────────────────────────

const SYNTHETIC_ID = '__merge__wf-X';
const WORKFLOW_ID = 'wf-X';

function seedCacheWithMergeNode(version: number): TaskSnapshotCache {
  const cache = new TaskSnapshotCache();
  cache.set(SYNTHETIC_ID, JSON.stringify(makeMergeNode(WORKFLOW_ID, version)));
  return cache;
}

function loadTaskNeverReturnsSynthetic(_id: string): TaskState | undefined {
  // Persistence never holds synthetic merge nodes.
  return undefined;
}

function copyCache(source: TaskSnapshotCache): TaskSnapshotCache {
  const clone = new TaskSnapshotCache();
  for (const id of source.keys()) {
    const snap = source.get(id);
    if (snap) clone.set(id, snap);
  }
  return clone;
}

// ── Repro cases ─────────────────────────────────────────────

describe('synthetic __merge__ quarantine-loop repro (graph-blank root cause)', () => {
  it('(a) synthetic gap recovers from orchestrator memory and emits created delta', () => {
    const cache = seedCacheWithMergeNode(2);
    const authoritative = makeMergeNode(WORKFLOW_ID, 4);
    const loaders: RecoveryLoaders = {
      loadTask: loadTaskNeverReturnsSynthetic,
      getMergeNode: (workflowId) => (workflowId === WORKFLOW_ID ? authoritative : undefined),
    };

    const delta: TaskDelta = {
      type: 'updated',
      taskId: SYNTHETIC_ID,
      changes: { status: 'completed' },
      taskStateVersion: 4,
      previousTaskStateVersion: 3,
    };

    const { rendererDeltas } = runRecovery(delta, cache, loaders);

    expect(cache.has(SYNTHETIC_ID)).toBe(true);
    expect(cache.getEntry(SYNTHETIC_ID)?.taskStateVersion).toBe(4);
    expect(rendererDeltas).toHaveLength(1);
    const first = rendererDeltas[0];
    expect(first.type).toBe('created');
    expect((first as { type: 'created'; task: TaskState }).task.id).toBe(SYNTHETIC_ID);
    expect((first as { type: 'created'; task: TaskState }).task.taskStateVersion).toBe(4);
  });

  it('(b) synthetic gap with no orchestrator entry emits removed delta', () => {
    const cache = seedCacheWithMergeNode(2);
    const loaders: RecoveryLoaders = {
      loadTask: loadTaskNeverReturnsSynthetic,
      getMergeNode: (_workflowId) => undefined,
    };

    const delta: TaskDelta = {
      type: 'updated',
      taskId: SYNTHETIC_ID,
      changes: { status: 'completed' },
      taskStateVersion: 4,
      previousTaskStateVersion: 3,
    };

    const { rendererDeltas } = runRecovery(delta, cache, loaders);

    expect(cache.has(SYNTHETIC_ID)).toBe(false);
    expect(rendererDeltas).toHaveLength(1);
    expect(rendererDeltas[0].type).toBe('removed');
    expect((rendererDeltas[0] as { type: 'removed'; taskId: string }).taskId).toBe(SYNTHETIC_ID);
  });

  it('(c) burst of stale out-of-order synthetic deltas quarantines once, then drops stale deltas', () => {
    // First delta is a real forward gap: cache is at v2, the delta expects v3,
    // and recovery loads the authoritative merge node at v10. Later deltas are
    // older than that recovered snapshot, so they must be dropped instead of
    // re-quarantining and re-sending created deltas in a loop.
    const cache = seedCacheWithMergeNode(2);
    const loaders: RecoveryLoaders = {
      loadTask: loadTaskNeverReturnsSynthetic,
      getMergeNode: (workflowId) =>
        workflowId === WORKFLOW_ID ? makeMergeNode(WORKFLOW_ID, 10) : undefined,
    };

    const allRendererDeltas: TaskDelta[] = [];
    let totalQuarantined = 0;

    const deltas: TaskDelta[] = [
      {
        type: 'updated',
        taskId: SYNTHETIC_ID,
        changes: { status: 'running' },
        taskStateVersion: 4,
        previousTaskStateVersion: 3,
      },
      {
        type: 'updated',
        taskId: SYNTHETIC_ID,
        changes: { status: 'completed' },
        taskStateVersion: 5,
        previousTaskStateVersion: 4,
      },
      {
        type: 'updated',
        taskId: SYNTHETIC_ID,
        changes: { status: 'failed' },
        taskStateVersion: 10,
        previousTaskStateVersion: 9,
      },
    ];

    for (const delta of deltas) {
      const beforeQuarantineState = applyDelta(delta, copyCache(cache));
      totalQuarantined += beforeQuarantineState.quarantined.length;

      const { rendererDeltas } = runRecovery(delta, cache, loaders);
      allRendererDeltas.push(...rendererDeltas);
    }

    expect(totalQuarantined).toBe(1);
    expect(allRendererDeltas).toHaveLength(1);
    expect(allRendererDeltas[0].type).toBe('created');
    expect(cache.getEntry(SYNTHETIC_ID)?.taskStateVersion).toBe(10);
  });

  it('(d) no implicit drops: non-synthetic ghost task emits removed delta', () => {
    // Cache is empty: an updated delta for an unknown non-synthetic id should
    // quarantine, persistence has no record, and recovery must still emit a
    // removed delta so the renderer's stale entry is cleared.
    const cache = new TaskSnapshotCache();
    const loaders: RecoveryLoaders = {
      loadTask: (_id) => undefined,
      getMergeNode: (_workflowId) => undefined,
    };

    const delta: TaskDelta = {
      type: 'updated',
      taskId: 't-ghost-real',
      changes: { status: 'completed' },
      taskStateVersion: 2,
      previousTaskStateVersion: 1,
    };

    const { rendererDeltas } = runRecovery(delta, cache, loaders);

    expect(cache.has('t-ghost-real')).toBe(false);
    expect(rendererDeltas).toHaveLength(1);
    expect(rendererDeltas[0].type).toBe('removed');
    expect((rendererDeltas[0] as { type: 'removed'; taskId: string }).taskId).toBe('t-ghost-real');
  });
});

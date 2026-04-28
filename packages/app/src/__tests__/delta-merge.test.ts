/**
 * Tests for the revision-aware delta-merge cache.
 *
 * Covers:
 * - created / removed deltas
 * - updated deltas with correct revision continuity
 * - revision gap → quarantine
 * - unknown task → quarantine
 * - quarantined task ignores further deltas until resolved
 * - resolveQuarantine re-seeds the cache from authoritative data
 * - TaskSnapshotCache bulk operations (set/get/clear/keys/delete)
 * - Regression: out-of-order updates never merge from orchestrator memory
 * - Integration: full quarantine → persistence load → recovery → resume flow
 * - Multi-task quarantine isolation
 */
import { describe, it, expect } from 'vitest';
import { applyDelta, resolveQuarantine, TaskSnapshotCache } from '../delta-merge.js';
import type { TaskState, TaskDelta } from '@invoker/workflow-core';

// ── Helpers ──────────────────────────────────────────────────

function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'running',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: { workflowId: 'wf-1', command: `echo ${id}`, executorType: 'worktree' as const },
    execution: {},
    revision: 1,
    ...overrides,
  } as TaskState;
}

// ── TaskSnapshotCache ────────────────────────────────────────

describe('TaskSnapshotCache', () => {
  it('set/get round-trips a snapshot and extracts revision', () => {
    const cache = new TaskSnapshotCache();
    const task = makeTask('t1', { revision: 3 });
    cache.set('t1', JSON.stringify(task));

    expect(cache.get('t1')).toBe(JSON.stringify(task));
    expect(cache.getEntry('t1')?.revision).toBe(3);
    expect(cache.getEntry('t1')?.quarantined).toBe(false);
  });

  it('has/delete/clear work as expected', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1')));
    cache.set('t2', JSON.stringify(makeTask('t2')));

    expect(cache.has('t1')).toBe(true);
    cache.delete('t1');
    expect(cache.has('t1')).toBe(false);

    cache.clear();
    expect(cache.has('t2')).toBe(false);
  });

  it('keys returns all task ids', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1')));
    cache.set('t2', JSON.stringify(makeTask('t2')));

    expect(new Set(cache.keys())).toEqual(new Set(['t1', 't2']));
  });

  it('defaults revision to 1 when task has no revision field', () => {
    const cache = new TaskSnapshotCache();
    const task = makeTask('t1');
    // Simulate a legacy snapshot without revision
    const legacy = { ...task } as Record<string, unknown>;
    delete legacy.revision;
    cache.set('t1', JSON.stringify(legacy));

    expect(cache.getEntry('t1')?.revision).toBe(1);
  });
});

// ── applyDelta ───────────────────────────────────────────────

describe('applyDelta', () => {
  describe('created delta', () => {
    it('stores the task snapshot with revision', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 2 });
      const delta: TaskDelta = { type: 'created', task };

      const result = applyDelta(delta, cache);

      expect(result.quarantined).toEqual([]);
      expect(cache.has('t1')).toBe(true);
      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.id).toBe('t1');
      expect(stored.status).toBe('running');
      expect(cache.getEntry('t1')?.revision).toBe(2);
    });
  });

  describe('updated delta with matching previousRevision', () => {
    it('merges changes and bumps revision', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 1 });
      cache.set('t1', JSON.stringify(task));

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
        revision: 2,
        previousRevision: 1,
      };

      const result = applyDelta(delta, cache);

      expect(result.quarantined).toEqual([]);
      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.status).toBe('completed');
      expect(stored.execution.exitCode).toBe(0);
      expect(stored.revision).toBe(2);
      expect(cache.getEntry('t1')?.revision).toBe(2);
    });

    it('chains two sequential updates', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 1 });
      cache.set('t1', JSON.stringify(task));

      applyDelta({
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
        revision: 2,
        previousRevision: 1,
      }, cache);

      applyDelta({
        type: 'updated',
        taskId: 't1',
        changes: { execution: { error: 'test failure' } },
        revision: 3,
        previousRevision: 2,
      }, cache);

      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.status).toBe('completed');
      expect(stored.execution.exitCode).toBe(0);
      expect(stored.execution.error).toBe('test failure');
      expect(stored.revision).toBe(3);
    });
  });

  describe('revision gap detection', () => {
    it('quarantines when previousRevision does not match cached revision', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 1 });
      cache.set('t1', JSON.stringify(task));

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed' },
        revision: 5,
        previousRevision: 4, // gap: cached revision is 1, not 4
      };

      const result = applyDelta(delta, cache);

      expect(result.quarantined).toEqual(['t1']);
      expect(cache.isQuarantined('t1')).toBe(true);
      // The snapshot should NOT have been updated
      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.status).toBe('running');
      expect(stored.revision).toBe(1);
    });

    it('quarantines when task is unknown (no prior created)', () => {
      const cache = new TaskSnapshotCache();

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 'unknown',
        changes: { status: 'completed' },
        revision: 2,
        previousRevision: 1,
      };

      const result = applyDelta(delta, cache);

      expect(result.quarantined).toEqual(['unknown']);
    });

    it('ignores deltas for quarantined tasks', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 1 });
      cache.set('t1', JSON.stringify(task));

      // First: trigger quarantine
      applyDelta({
        type: 'updated',
        taskId: 't1',
        changes: { status: 'failed' },
        revision: 10,
        previousRevision: 9,
      }, cache);
      expect(cache.isQuarantined('t1')).toBe(true);

      // Second: another delta arrives while quarantined — should be ignored
      const result = applyDelta({
        type: 'updated',
        taskId: 't1',
        changes: { status: 'completed' },
        revision: 11,
        previousRevision: 10,
      }, cache);

      expect(result.quarantined).toEqual([]);
      // Snapshot unchanged from original
      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.status).toBe('running');
    });
  });

  describe('removed delta', () => {
    it('removes the task from the cache', () => {
      const cache = new TaskSnapshotCache();
      cache.set('t1', JSON.stringify(makeTask('t1')));

      const delta: TaskDelta = { type: 'removed', taskId: 't1', previousRevision: 1 };

      applyDelta(delta, cache);

      expect(cache.has('t1')).toBe(false);
    });
  });

  describe('config merging', () => {
    it('merges config changes without losing existing config fields', () => {
      const cache = new TaskSnapshotCache();
      const task = makeTask('t1', { revision: 1 });
      cache.set('t1', JSON.stringify(task));

      const delta: TaskDelta = {
        type: 'updated',
        taskId: 't1',
        changes: { config: { command: 'echo updated' } },
        revision: 2,
        previousRevision: 1,
      };

      applyDelta(delta, cache);

      const stored = JSON.parse(cache.get('t1')!);
      expect(stored.config.command).toBe('echo updated');
      expect(stored.config.workflowId).toBe('wf-1');
    });
  });
});

// ── resolveQuarantine ────────────────────────────────────────

describe('resolveQuarantine', () => {
  it('replaces quarantined entry with authoritative task', () => {
    const cache = new TaskSnapshotCache();
    const task = makeTask('t1', { revision: 1 });
    cache.set('t1', JSON.stringify(task));

    // Quarantine via gap
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed' },
      revision: 5,
      previousRevision: 4,
    }, cache);
    expect(cache.isQuarantined('t1')).toBe(true);

    // Resolve with authoritative state
    const authoritative = makeTask('t1', { revision: 5, status: 'completed' });
    resolveQuarantine(cache, 't1', authoritative);

    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.getEntry('t1')?.revision).toBe(5);
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');
  });

  it('removes entry when task no longer exists in persistence', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1')));

    resolveQuarantine(cache, 't1', undefined);

    expect(cache.has('t1')).toBe(false);
  });

  it('allows normal delta processing after recovery', () => {
    const cache = new TaskSnapshotCache();
    const task = makeTask('t1', { revision: 1 });
    cache.set('t1', JSON.stringify(task));

    // Quarantine
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed' },
      revision: 3,
      previousRevision: 2,
    }, cache);

    // Resolve
    const authoritative = makeTask('t1', { revision: 3, status: 'failed' });
    resolveQuarantine(cache, 't1', authoritative);

    // Now a delta with correct continuity should apply
    const result = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { execution: { exitCode: 1 } },
      revision: 4,
      previousRevision: 3,
    }, cache);

    expect(result.quarantined).toEqual([]);
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('failed');
    expect(stored.execution.exitCode).toBe(1);
    expect(stored.revision).toBe(4);
  });
});

// ── Gap recovery: main-process integration simulation ────────
//
// These tests simulate the recovery loop from main.ts (lines 2429-2437):
//   1. applyDelta detects gap → returns quarantined IDs
//   2. caller loads authoritative state from persistence (loadTask)
//   3. resolveQuarantine re-seeds cache
//   4. caller sends { type: 'created', task: authoritative } to renderer
//
// The mock persistence loader is a plain function, not a real SQLite
// adapter, which keeps tests deterministic and fast.

/** Simulates the main-process recovery loop from main.ts. */
function simulateMainProcessDeltaHandler(
  delta: TaskDelta,
  cache: TaskSnapshotCache,
  persistence: { loadTask: (id: string) => TaskState | undefined },
): { rendererDeltas: TaskDelta[] } {
  const rendererDeltas: TaskDelta[] = [];

  const { quarantined } = applyDelta(delta, cache);
  for (const taskId of quarantined) {
    const authoritative = persistence.loadTask(taskId);
    resolveQuarantine(cache, taskId, authoritative);
    if (authoritative) {
      rendererDeltas.push({ type: 'created', task: authoritative });
    }
  }
  return { rendererDeltas };
}

describe('gap recovery: unknown task → quarantine + authoritative reload', () => {
  it('unknown task triggers quarantine and sends authoritative snapshot to renderer', () => {
    const cache = new TaskSnapshotCache();
    const authoritativeTask = makeTask('t1', { revision: 3, status: 'completed' });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    const delta: TaskDelta = {
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 4,
      previousRevision: 3,
    };

    const { rendererDeltas } = simulateMainProcessDeltaHandler(delta, cache, persistence);

    // Cache was recovered with authoritative state
    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.getEntry('t1')?.revision).toBe(3);
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');

    // Renderer received the authoritative snapshot as a created delta
    expect(rendererDeltas).toHaveLength(1);
    expect(rendererDeltas[0].type).toBe('created');
    expect((rendererDeltas[0] as { type: 'created'; task: TaskState }).task.id).toBe('t1');
    expect((rendererDeltas[0] as { type: 'created'; task: TaskState }).task.revision).toBe(3);
  });

  it('unknown task with no persistence record removes cache entry silently', () => {
    const cache = new TaskSnapshotCache();
    const persistence = { loadTask: (_id: string) => undefined };

    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'ghost',
      changes: { status: 'completed' },
      revision: 2,
      previousRevision: 1,
    };

    const { rendererDeltas } = simulateMainProcessDeltaHandler(delta, cache, persistence);

    expect(cache.has('ghost')).toBe(false);
    // No renderer delta emitted for a task that doesn't exist in persistence
    expect(rendererDeltas).toHaveLength(0);
  });
});

describe('gap recovery: revision gap → quarantine + authoritative reload', () => {
  it('revision gap triggers quarantine and replaces stale cache with authoritative state', () => {
    const cache = new TaskSnapshotCache();
    // Cache has task at revision 2
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 2, status: 'running' })));

    // Persistence has task at revision 7 (several revisions ahead)
    const authoritativeTask = makeTask('t1', {
      revision: 7,
      status: 'completed',
      execution: { exitCode: 0 },
    });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    // Delta arrives referencing revision 7 → 8, but cache is at 2
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 't1',
      changes: { execution: { error: 'timeout' } },
      revision: 8,
      previousRevision: 7,
    };

    const { rendererDeltas } = simulateMainProcessDeltaHandler(delta, cache, persistence);

    // Cache was recovered: snapshot matches authoritative (rev 7), not the
    // stale rev-2 snapshot and not the gap delta's changes.
    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.getEntry('t1')?.revision).toBe(7);
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');
    expect(stored.execution.exitCode).toBe(0);
    // The delta's changes (error: 'timeout') were NOT merged — the
    // old best-effort orchestrator-memory merge is gone.
    expect(stored.execution.error).toBeUndefined();

    // Renderer received authoritative snapshot
    expect(rendererDeltas).toHaveLength(1);
    expect((rendererDeltas[0] as { type: 'created'; task: TaskState }).task.revision).toBe(7);
  });

  it('revision gap with single missed revision still quarantines', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 3 })));

    const authoritativeTask = makeTask('t1', { revision: 4, status: 'running' });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    // Delta has previousRevision: 4 but cache is at 3
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed' },
      revision: 5,
      previousRevision: 4,
    };

    const { rendererDeltas } = simulateMainProcessDeltaHandler(delta, cache, persistence);

    expect(cache.getEntry('t1')?.revision).toBe(4);
    expect(rendererDeltas).toHaveLength(1);
  });
});

describe('gap recovery: quarantined task ignores later deltas until reload completes', () => {
  it('burst of deltas during quarantine are all dropped; only authoritative state remains', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1, status: 'pending' })));

    // Step 1: Gap delta triggers quarantine (don't resolve yet)
    const gapResult = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 5,
      previousRevision: 4,
    }, cache);
    expect(gapResult.quarantined).toEqual(['t1']);
    expect(cache.isQuarantined('t1')).toBe(true);

    // Step 2: Multiple deltas arrive while quarantined — all ignored
    for (let rev = 6; rev <= 10; rev++) {
      const result = applyDelta({
        type: 'updated',
        taskId: 't1',
        changes: { status: `status-at-rev-${rev}` as TaskState['status'] },
        revision: rev,
        previousRevision: rev - 1,
      }, cache);
      expect(result.quarantined).toEqual([]);
    }

    // Cache snapshot is unchanged from before quarantine
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('pending');
    expect(stored.revision).toBe(1);
    expect(cache.isQuarantined('t1')).toBe(true);

    // Step 3: Resolve with authoritative state
    const authoritative = makeTask('t1', { revision: 10, status: 'completed' });
    resolveQuarantine(cache, 't1', authoritative);

    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.getEntry('t1')?.revision).toBe(10);
    const final = JSON.parse(cache.get('t1')!);
    expect(final.status).toBe('completed');
  });

  it('quarantine flag survives multiple ignored deltas with different change shapes', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));

    // Trigger quarantine
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed' },
      revision: 3,
      previousRevision: 2,
    }, cache);

    // Try config change — ignored
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { config: { command: 'echo hacked' } },
      revision: 4,
      previousRevision: 3,
    }, cache);

    // Try execution change — ignored
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { execution: { exitCode: 99 } },
      revision: 5,
      previousRevision: 4,
    }, cache);

    // Original snapshot preserved
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.config.command).toBe('echo t1');
    expect(stored.execution).toEqual({});
    expect(stored.status).toBe('running');
  });
});

describe('gap recovery: successful reload clears quarantine and allows next ordered delta', () => {
  it('post-recovery delta with correct continuity applies normally', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));

    const authoritativeTask = makeTask('t1', { revision: 5, status: 'running' });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    // Gap delta → quarantine → recovery
    simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed' },
      revision: 6,
      previousRevision: 5,
    }, cache, persistence);

    // Cache is now at authoritative revision 5, not quarantined
    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.getEntry('t1')?.revision).toBe(5);

    // Next delta with correct previousRevision=5 should apply
    const result = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      revision: 6,
      previousRevision: 5,
    }, cache);

    expect(result.quarantined).toEqual([]);
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');
    expect(stored.execution.exitCode).toBe(0);
    expect(stored.revision).toBe(6);
  });

  it('post-recovery delta with wrong continuity re-quarantines', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));

    const authoritativeTask = makeTask('t1', { revision: 5, status: 'running' });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    // Gap delta → recovery (cache now at rev 5)
    simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 8,
      previousRevision: 7,
    }, cache, persistence);

    expect(cache.getEntry('t1')?.revision).toBe(5);

    // A delta referencing rev 7 → 8 still doesn't match (cache is at 5)
    const result = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed' },
      revision: 8,
      previousRevision: 7,
    }, cache);

    expect(result.quarantined).toEqual(['t1']);
    expect(cache.isQuarantined('t1')).toBe(true);
  });
});

// ── Regression: out-of-order updates must not merge from orchestrator memory ──

describe('regression: out-of-order updates never merge from orchestrator memory', () => {
  it('a delta that skips revisions is rejected, not silently merged', () => {
    const cache = new TaskSnapshotCache();
    // Task at revision 2 with status 'running'
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 2, status: 'running' })));

    // Delta arrives claiming previousRevision: 5 → revision: 6.
    // In the old best-effort system, this would have been merged anyway.
    // In the new system, it must quarantine.
    const result = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      revision: 6,
      previousRevision: 5,
    }, cache);

    expect(result.quarantined).toEqual(['t1']);
    // The delta's changes must NOT appear in the cache
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('running');
    expect(stored.execution).toEqual({});
    expect(stored.revision).toBe(2);
  });

  it('a stale delta referencing an older revision is rejected, not merged', () => {
    const cache = new TaskSnapshotCache();
    // Task has progressed to revision 5
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 5, status: 'completed' })));

    // A stale delta arrives from an older revision window (rev 2 → 3)
    const result = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 3,
      previousRevision: 2,
    }, cache);

    expect(result.quarantined).toEqual(['t1']);
    // Cache still shows revision 5, not downgraded
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');
    expect(stored.revision).toBe(5);
  });

  it('recovery always uses persistence, never the delta changes', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 2 })));

    // The delta says status should be 'failed', but persistence says 'completed'
    const authoritativeTask = makeTask('t1', {
      revision: 8,
      status: 'completed',
      execution: { exitCode: 0 },
    });
    const persistence = { loadTask: (_id: string) => authoritativeTask };

    simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed', execution: { error: 'crash' } },
      revision: 9,
      previousRevision: 8,
    }, cache, persistence);

    // The cache must reflect persistence, NOT the delta's changes
    const stored = JSON.parse(cache.get('t1')!);
    expect(stored.status).toBe('completed');
    expect(stored.execution.exitCode).toBe(0);
    expect(stored.execution.error).toBeUndefined();
    expect(stored.revision).toBe(8);
  });
});

// ── Multi-task quarantine isolation ──────────────────────────

describe('multi-task quarantine isolation', () => {
  it('quarantine on one task does not affect deltas for other tasks', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));
    cache.set('t2', JSON.stringify(makeTask('t2', { revision: 1 })));

    // Quarantine t1
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed' },
      revision: 5,
      previousRevision: 4,
    }, cache);
    expect(cache.isQuarantined('t1')).toBe(true);

    // t2 can still receive normal deltas
    const result = applyDelta({
      type: 'updated',
      taskId: 't2',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      revision: 2,
      previousRevision: 1,
    }, cache);

    expect(result.quarantined).toEqual([]);
    expect(cache.isQuarantined('t2')).toBe(false);
    const stored = JSON.parse(cache.get('t2')!);
    expect(stored.status).toBe('completed');
    expect(stored.revision).toBe(2);
  });

  it('multiple tasks can be quarantined and recovered independently', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));
    cache.set('t2', JSON.stringify(makeTask('t2', { revision: 1 })));

    // Quarantine both
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'failed' },
      revision: 5,
      previousRevision: 4,
    }, cache);
    applyDelta({
      type: 'updated',
      taskId: 't2',
      changes: { status: 'failed' },
      revision: 3,
      previousRevision: 2,
    }, cache);
    expect(cache.isQuarantined('t1')).toBe(true);
    expect(cache.isQuarantined('t2')).toBe(true);

    // Recover t1 only
    resolveQuarantine(cache, 't1', makeTask('t1', { revision: 5, status: 'completed' }));
    expect(cache.isQuarantined('t1')).toBe(false);
    expect(cache.isQuarantined('t2')).toBe(true);

    // t1 accepts deltas again; t2 still ignores
    const r1 = applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { execution: { exitCode: 0 } },
      revision: 6,
      previousRevision: 5,
    }, cache);
    const r2 = applyDelta({
      type: 'updated',
      taskId: 't2',
      changes: { execution: { exitCode: 1 } },
      revision: 4,
      previousRevision: 3,
    }, cache);

    expect(r1.quarantined).toEqual([]);
    expect(r2.quarantined).toEqual([]); // ignored, not re-quarantined
    expect(JSON.parse(cache.get('t1')!).execution.exitCode).toBe(0);
    // t2's delta was silently ignored — execution unchanged
    expect(JSON.parse(cache.get('t2')!).execution).toEqual({});

    // Recover t2
    resolveQuarantine(cache, 't2', makeTask('t2', { revision: 3, status: 'failed' }));
    expect(cache.isQuarantined('t2')).toBe(false);
  });
});

// ── End-to-end recovery flow ────────────────────────────────

describe('end-to-end recovery flow', () => {
  it('full lifecycle: create → update → gap → quarantine → recover → update → remove', () => {
    const cache = new TaskSnapshotCache();

    // Phase 1: Task created
    applyDelta({ type: 'created', task: makeTask('t1', { revision: 1, status: 'pending' }) }, cache);
    expect(cache.getEntry('t1')?.revision).toBe(1);

    // Phase 2: Normal updates (revisions 1→2→3)
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 2,
      previousRevision: 1,
    }, cache);
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { execution: { generation: 2 } },
      revision: 3,
      previousRevision: 2,
    }, cache);
    expect(cache.getEntry('t1')?.revision).toBe(3);

    // Phase 3: Gap detected (delta refs rev 6 → 7, but cache is at 3)
    const persistence = {
      loadTask: (_id: string) =>
        makeTask('t1', { revision: 6, status: 'running', execution: { generation: 3 } }),
    };
    const { rendererDeltas } = simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed' },
      revision: 7,
      previousRevision: 6,
    }, cache, persistence);

    // Recovery happened
    expect(cache.getEntry('t1')?.revision).toBe(6);
    expect(cache.isQuarantined('t1')).toBe(false);
    expect(rendererDeltas).toHaveLength(1);

    // Phase 4: Resume normal deltas from recovered revision
    applyDelta({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      revision: 7,
      previousRevision: 6,
    }, cache);
    expect(cache.getEntry('t1')?.revision).toBe(7);

    // Phase 5: Task removed
    applyDelta({ type: 'removed', taskId: 't1', previousRevision: 7 }, cache);
    expect(cache.has('t1')).toBe(false);
  });

  it('concurrent gap recovery for two tasks in the same delta batch', () => {
    const cache = new TaskSnapshotCache();
    cache.set('t1', JSON.stringify(makeTask('t1', { revision: 1 })));
    cache.set('t2', JSON.stringify(makeTask('t2', { revision: 1 })));

    const persistence = {
      loadTask: (id: string) => {
        if (id === 't1') return makeTask('t1', { revision: 5, status: 'completed' });
        if (id === 't2') return makeTask('t2', { revision: 3, status: 'failed' });
        return undefined;
      },
    };

    // Process two gap deltas sequentially (as main.ts does)
    simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't1',
      changes: { status: 'running' },
      revision: 6,
      previousRevision: 5,
    }, cache, persistence);

    simulateMainProcessDeltaHandler({
      type: 'updated',
      taskId: 't2',
      changes: { status: 'running' },
      revision: 4,
      previousRevision: 3,
    }, cache, persistence);

    // Both recovered independently to their authoritative states
    expect(cache.getEntry('t1')?.revision).toBe(5);
    expect(cache.getEntry('t2')?.revision).toBe(3);
    expect(JSON.parse(cache.get('t1')!).status).toBe('completed');
    expect(JSON.parse(cache.get('t2')!).status).toBe('failed');
  });
});

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

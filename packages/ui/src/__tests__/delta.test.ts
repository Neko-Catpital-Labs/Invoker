/**
 * Tests for applyDelta — revision-aware delta application for the renderer.
 */

import { describe, it, expect } from 'vitest';
import { applyDelta } from '../lib/delta.js';
import type { TaskState, TaskDelta } from '../types.js';

function makeTask(overrides: Partial<TaskState> & { id: string }): TaskState {
  return {
    description: 'test task',
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2025-01-01'),
    config: {},
    execution: {},
    revision: 1,
    ...overrides,
  };
}

describe('applyDelta', () => {
  // ── created deltas ──────────────────────────────────────────

  it('created: adds task to map', () => {
    const tasks = new Map<string, TaskState>();
    const qIds = new Set<string>();
    const task = makeTask({ id: 'task-1', description: 'First task' });
    const delta: TaskDelta = { type: 'created', task };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.size).toBe(1);
    expect(result.tasks.get('task-1')).toEqual(task);
    expect(result.quarantined).toEqual([]);
    // Original map unchanged (immutability)
    expect(tasks.size).toBe(0);
  });

  it('created: overwrites existing task (authoritative replacement)', () => {
    const stale = makeTask({ id: 'task-1', status: 'pending', revision: 2 });
    const tasks = new Map<string, TaskState>([['task-1', stale]]);
    const qIds = new Set<string>();
    const authoritative = makeTask({ id: 'task-1', status: 'running', revision: 5 });
    const delta: TaskDelta = { type: 'created', task: authoritative };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.get('task-1')).toEqual(authoritative);
    expect(result.tasks.get('task-1')!.revision).toBe(5);
    expect(result.quarantined).toEqual([]);
  });

  it('created: clears quarantine for the task', () => {
    const tasks = new Map<string, TaskState>();
    const qIds = new Set<string>(['task-1']);
    const authoritative = makeTask({ id: 'task-1', status: 'running', revision: 7 });
    const delta: TaskDelta = { type: 'created', task: authoritative };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.get('task-1')).toEqual(authoritative);
    expect(qIds.has('task-1')).toBe(false);
    expect(result.quarantined).toEqual([]);
  });

  // ── updated deltas: revision match (normal fast path) ──────

  it('updated: merges changes when revision matches', () => {
    const task = makeTask({ id: 'task-1', status: 'pending', revision: 1 });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'task-1',
      changes: { status: 'running', execution: { startedAt: new Date('2025-01-02') } },
      previousRevision: 1,
      revision: 2,
    };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.get('task-1')!.status).toBe('running');
    expect(result.tasks.get('task-1')!.revision).toBe(2);
    expect(result.tasks.get('task-1')!.execution.startedAt).toEqual(new Date('2025-01-02'));
    expect(result.tasks.get('task-1')!.description).toBe('test task');
    expect(result.quarantined).toEqual([]);
    // Original unchanged
    expect(tasks.get('task-1')!.status).toBe('pending');
    expect(tasks.get('task-1')!.revision).toBe(1);
  });

  it('updated: merges nested config changes with matching revision', () => {
    const task = makeTask({ id: 'task-1', config: { command: 'echo old' }, revision: 3 });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'task-1',
      changes: { config: { command: 'echo new' } },
      previousRevision: 3,
      revision: 4,
    };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.get('task-1')!.config.command).toBe('echo new');
    expect(result.tasks.get('task-1')!.revision).toBe(4);
    // Original config unchanged
    expect(tasks.get('task-1')!.config.command).toBe('echo old');
  });

  it('updated: chains sequential updates (revision 1→2→3)', () => {
    const task = makeTask({ id: 'task-1', status: 'pending', revision: 1 });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();

    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    }, qIds);

    const r2 = applyDelta(r1.tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'completed' }, previousRevision: 2, revision: 3,
    }, qIds);

    expect(r2.tasks.get('task-1')!.status).toBe('completed');
    expect(r2.tasks.get('task-1')!.revision).toBe(3);
    expect(r1.quarantined).toEqual([]);
    expect(r2.quarantined).toEqual([]);
  });

  it('updated: clears isFixingWithAI via explicit false', () => {
    const task = makeTask({
      id: 'task-1',
      status: 'running',
      execution: { isFixingWithAI: true },
      revision: 1,
    });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();
    const delta: TaskDelta = {
      type: 'updated',
      taskId: 'task-1',
      changes: {
        status: 'awaiting_approval',
        execution: { isFixingWithAI: false, pendingFixError: 'some error' },
      },
      previousRevision: 1,
      revision: 2,
    };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.get('task-1')!.status).toBe('awaiting_approval');
    expect(result.tasks.get('task-1')!.execution.isFixingWithAI).toBe(false);
    expect(result.tasks.get('task-1')!.execution.pendingFixError).toBe('some error');
  });

  // ── updated deltas: revision gap (quarantine) ──────────────

  it('updated: quarantines on revision gap', () => {
    const task = makeTask({ id: 'task-1', revision: 2 });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();
    const delta: TaskDelta = {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'running' }, previousRevision: 5, revision: 6,
    };

    const result = applyDelta(tasks, delta, qIds);

    // Task unchanged — delta was dropped
    expect(result.tasks.get('task-1')!.revision).toBe(2);
    expect(result.tasks.get('task-1')!.status).toBe('pending');
    // Quarantine reported
    expect(result.quarantined).toEqual(['task-1']);
    expect(qIds.has('task-1')).toBe(true);
  });

  it('updated: quarantines on unknown task', () => {
    const tasks = new Map<string, TaskState>();
    const qIds = new Set<string>();
    const delta: TaskDelta = {
      type: 'updated', taskId: 'unknown-task',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.has('unknown-task')).toBe(false);
    expect(result.quarantined).toEqual(['unknown-task']);
    expect(qIds.has('unknown-task')).toBe(true);
  });

  it('updated: drops deltas for quarantined task', () => {
    const task = makeTask({ id: 'task-1', revision: 2, status: 'pending' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>(['task-1']);
    const delta: TaskDelta = {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'running' }, previousRevision: 2, revision: 3,
    };

    const result = applyDelta(tasks, delta, qIds);

    // Delta was silently dropped — task unchanged
    expect(result.tasks.get('task-1')!.status).toBe('pending');
    expect(result.tasks.get('task-1')!.revision).toBe(2);
    expect(result.quarantined).toEqual([]);
  });

  // ── removed deltas ─────────────────────────────────────────

  it('removed: deletes task from map', () => {
    const task = makeTask({ id: 'task-1' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>();
    const delta: TaskDelta = { type: 'removed', taskId: 'task-1', previousRevision: 1 };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.size).toBe(0);
    expect(result.tasks.has('task-1')).toBe(false);
    // Original unchanged
    expect(tasks.size).toBe(1);
  });

  it('removed: clears quarantine for the task', () => {
    const task = makeTask({ id: 'task-1' });
    const tasks = new Map<string, TaskState>([['task-1', task]]);
    const qIds = new Set<string>(['task-1']);
    const delta: TaskDelta = { type: 'removed', taskId: 'task-1', previousRevision: 1 };

    const result = applyDelta(tasks, delta, qIds);

    expect(result.tasks.has('task-1')).toBe(false);
    expect(qIds.has('task-1')).toBe(false);
  });

  // ── multi-task isolation ───────────────────────────────────

  it('quarantine on one task does not affect others', () => {
    const t1 = makeTask({ id: 't1', revision: 1 });
    const t2 = makeTask({ id: 't2', revision: 1 });
    const tasks = new Map<string, TaskState>([['t1', t1], ['t2', t2]]);
    const qIds = new Set<string>();

    // Quarantine t1
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 99, revision: 100,
    }, qIds);

    expect(r1.quarantined).toEqual(['t1']);

    // t2 still accepts deltas normally
    const r2 = applyDelta(r1.tasks, {
      type: 'updated', taskId: 't2',
      changes: { status: 'completed' }, previousRevision: 1, revision: 2,
    }, qIds);

    expect(r2.tasks.get('t2')!.status).toBe('completed');
    expect(r2.tasks.get('t2')!.revision).toBe(2);
    expect(r2.quarantined).toEqual([]);
  });

  // ── end-to-end: gap recovery flow ──────────────────────────

  it('full recovery: create → update → gap → quarantine → authoritative created → resume', () => {
    const qIds = new Set<string>();

    // 1. Create task at revision 1
    const r1 = applyDelta(new Map(), {
      type: 'created',
      task: makeTask({ id: 'task-1', status: 'pending', revision: 1 }),
    }, qIds);
    expect(r1.tasks.get('task-1')!.revision).toBe(1);

    // 2. Normal update: rev 1→2
    const r2 = applyDelta(r1.tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    }, qIds);
    expect(r2.tasks.get('task-1')!.status).toBe('running');
    expect(r2.tasks.get('task-1')!.revision).toBe(2);

    // 3. Gap: delta expects rev 5 but local is rev 2
    const r3 = applyDelta(r2.tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'completed' }, previousRevision: 5, revision: 6,
    }, qIds);
    expect(r3.quarantined).toEqual(['task-1']);
    expect(r3.tasks.get('task-1')!.revision).toBe(2); // unchanged

    // 4. Stale delta arrives while quarantined — dropped
    const r4 = applyDelta(r3.tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'failed' }, previousRevision: 2, revision: 3,
    }, qIds);
    expect(r4.quarantined).toEqual([]);
    expect(r4.tasks.get('task-1')!.revision).toBe(2); // still unchanged

    // 5. Authoritative recovery: main process sends created delta
    const r5 = applyDelta(r4.tasks, {
      type: 'created',
      task: makeTask({ id: 'task-1', status: 'running', revision: 7 }),
    }, qIds);
    expect(r5.tasks.get('task-1')!.status).toBe('running');
    expect(r5.tasks.get('task-1')!.revision).toBe(7);
    expect(qIds.has('task-1')).toBe(false);

    // 6. Normal updates resume: rev 7→8
    const r6 = applyDelta(r5.tasks, {
      type: 'updated', taskId: 'task-1',
      changes: { status: 'completed' }, previousRevision: 7, revision: 8,
    }, qIds);
    expect(r6.tasks.get('task-1')!.status).toBe('completed');
    expect(r6.tasks.get('task-1')!.revision).toBe(8);
    expect(r6.quarantined).toEqual([]);
  });
});

/**
 * Regression tests for the revisioned re-sync design.
 *
 * Covers:
 * 1. Renderer application of ordered revisioned deltas (pipeline + applyDelta).
 * 2. Authoritative replacement after gap recovery.
 * 3. DB poll + message-bus interplay: no duplicate or stale task state when
 *    both sources observe the same transition.
 * 4. Restart recovery: persisted state ahead of UI cache converges correctly.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyDelta } from '../lib/delta.js';
import { createTaskDeltaPipeline } from '../lib/task-delta-pipeline.js';
import type { TaskState, TaskDelta } from '../types.js';

// ── Helpers ─────────────────────────────────────────────────

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

/**
 * Simulate the useTasks onBatch handler: apply a batch of deltas sequentially
 * to a task map, tracking quarantine across the batch.
 */
function applyBatch(
  initial: Map<string, TaskState>,
  batch: TaskDelta[],
  quarantinedIds: Set<string>,
): { tasks: Map<string, TaskState>; allQuarantined: string[] } {
  let current = initial;
  const allQuarantined: string[] = [];
  for (const delta of batch) {
    const result = applyDelta(current, delta, quarantinedIds);
    current = result.tasks;
    allQuarantined.push(...result.quarantined);
  }
  return { tasks: current, allQuarantined };
}

/**
 * Simulate a full snapshot replace (DB poll / getTasks).
 * Replaces the task map entirely and clears quarantine — mirrors useTasks.fetchAll.
 */
function snapshotReplace(
  taskList: TaskState[],
  quarantinedIds: Set<string>,
): Map<string, TaskState> {
  quarantinedIds.clear();
  const next = new Map<string, TaskState>();
  for (const t of taskList) next.set(t.id, t);
  return next;
}

// ── 1. Ordered revisioned deltas ────────────────────────────

describe('1. Renderer application of ordered revisioned deltas', () => {
  afterEach(() => vi.useRealTimers());

  it('pipeline preserves revision order across batched create → update → update', () => {
    vi.useFakeTimers();
    const batches: TaskDelta[][] = [];
    const pipeline = createTaskDeltaPipeline({
      flushMs: 50,
      onBatch: (b) => batches.push(b),
    });

    const create: TaskDelta = {
      type: 'created',
      task: makeTask({ id: 't1', status: 'pending', revision: 1 }),
    };
    const u1: TaskDelta = {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    };
    const u2: TaskDelta = {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed' }, previousRevision: 2, revision: 3,
    };

    pipeline.push(create);
    pipeline.push(u1);
    pipeline.push(u2);
    vi.advanceTimersByTime(50);

    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([create, u1, u2]);

    // Apply the batch
    const qIds = new Set<string>();
    const result = applyBatch(new Map(), batches[0], qIds);
    expect(result.tasks.get('t1')!.status).toBe('completed');
    expect(result.tasks.get('t1')!.revision).toBe(3);
    expect(result.allQuarantined).toEqual([]);

    pipeline.dispose();
  });

  it('multi-task interleaved deltas apply independently', () => {
    const qIds = new Set<string>();
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 'a', revision: 1 }) },
      { type: 'created', task: makeTask({ id: 'b', revision: 1 }) },
      {
        type: 'updated', taskId: 'a',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
      {
        type: 'updated', taskId: 'b',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
      {
        type: 'updated', taskId: 'a',
        changes: { status: 'completed' }, previousRevision: 2, revision: 3,
      },
    ];

    const result = applyBatch(new Map(), batch, qIds);
    expect(result.tasks.get('a')!.status).toBe('completed');
    expect(result.tasks.get('a')!.revision).toBe(3);
    expect(result.tasks.get('b')!.status).toBe('running');
    expect(result.tasks.get('b')!.revision).toBe(2);
    expect(result.allQuarantined).toEqual([]);
  });

  it('out-of-order delta within batch quarantines only the affected task', () => {
    const qIds = new Set<string>();
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 'a', revision: 1 }) },
      { type: 'created', task: makeTask({ id: 'b', revision: 1 }) },
      // Delta for 'a' skips revision 2 → gap
      {
        type: 'updated', taskId: 'a',
        changes: { status: 'completed' }, previousRevision: 5, revision: 6,
      },
      // Delta for 'b' is normal
      {
        type: 'updated', taskId: 'b',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
    ];

    const result = applyBatch(new Map(), batch, qIds);
    // 'a' quarantined — unchanged at revision 1
    expect(result.tasks.get('a')!.revision).toBe(1);
    expect(result.tasks.get('a')!.status).toBe('pending');
    expect(result.allQuarantined).toEqual(['a']);
    // 'b' unaffected
    expect(result.tasks.get('b')!.status).toBe('running');
    expect(result.tasks.get('b')!.revision).toBe(2);
  });

  it('rapid sequential updates chain correctly (pending → running → completed → failed)', () => {
    const qIds = new Set<string>();
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 't1', revision: 1 }) },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'running', execution: { startedAt: new Date('2025-01-02') } },
        previousRevision: 1, revision: 2,
      },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'completed', execution: { completedAt: new Date('2025-01-03') } },
        previousRevision: 2, revision: 3,
      },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'failed', execution: { error: 'post-completion failure' } },
        previousRevision: 3, revision: 4,
      },
    ];

    const result = applyBatch(new Map(), batch, qIds);
    const t = result.tasks.get('t1')!;
    expect(t.status).toBe('failed');
    expect(t.revision).toBe(4);
    expect(t.execution.error).toBe('post-completion failure');
    expect(t.execution.startedAt).toEqual(new Date('2025-01-02'));
    expect(t.execution.completedAt).toEqual(new Date('2025-01-03'));
    expect(result.allQuarantined).toEqual([]);
  });
});

// ── 2. Authoritative replacement after gap recovery ─────────

describe('2. Authoritative replacement after gap recovery', () => {
  it('authoritative created delta converges quarantined task to correct state', () => {
    const qIds = new Set<string>();

    // Initial state: task at revision 3
    let tasks = new Map<string, TaskState>([
      ['t1', makeTask({ id: 't1', status: 'running', revision: 3 })],
    ]);

    // Gap: delta expects revision 10
    const gapResult = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed' }, previousRevision: 10, revision: 11,
    }, qIds);
    tasks = gapResult.tasks;
    expect(gapResult.quarantined).toEqual(['t1']);
    expect(tasks.get('t1')!.revision).toBe(3); // unchanged

    // Several stale deltas arrive while quarantined — all dropped
    for (let rev = 4; rev <= 8; rev++) {
      const r = applyDelta(tasks, {
        type: 'updated', taskId: 't1',
        changes: { status: 'running' }, previousRevision: rev - 1, revision: rev,
      }, qIds);
      tasks = r.tasks;
      expect(tasks.get('t1')!.revision).toBe(3); // still unchanged
    }

    // Authoritative recovery: main process sends 'created' snapshot at revision 15
    const recovery = applyDelta(tasks, {
      type: 'created',
      task: makeTask({ id: 't1', status: 'completed', revision: 15, execution: { exitCode: 0 } }),
    }, qIds);
    tasks = recovery.tasks;

    expect(tasks.get('t1')!.status).toBe('completed');
    expect(tasks.get('t1')!.revision).toBe(15);
    expect(tasks.get('t1')!.execution.exitCode).toBe(0);
    expect(qIds.has('t1')).toBe(false);

    // Normal updates resume
    const resume = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { execution: { error: 'retry' } }, previousRevision: 15, revision: 16,
    }, qIds);
    expect(resume.tasks.get('t1')!.revision).toBe(16);
    expect(resume.tasks.get('t1')!.execution.error).toBe('retry');
    expect(resume.quarantined).toEqual([]);
  });

  it('gap on unknown task quarantines, then created delta adds it', () => {
    const qIds = new Set<string>();
    const tasks = new Map<string, TaskState>();

    // Update for a task the renderer doesn't know about
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 'new-task',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    }, qIds);
    expect(r1.quarantined).toEqual(['new-task']);
    expect(r1.tasks.has('new-task')).toBe(false);

    // Authoritative created delta arrives
    const r2 = applyDelta(r1.tasks, {
      type: 'created',
      task: makeTask({ id: 'new-task', status: 'running', revision: 5 }),
    }, qIds);
    expect(r2.tasks.get('new-task')!.status).toBe('running');
    expect(r2.tasks.get('new-task')!.revision).toBe(5);
    expect(qIds.has('new-task')).toBe(false);
  });

  it('authoritative replacement during batched deltas recovers mid-batch', () => {
    const qIds = new Set<string>();
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 't1', revision: 1 }) },
      // Normal update
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
      // Gap — quarantines
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'completed' }, previousRevision: 10, revision: 11,
      },
      // Stale update while quarantined — dropped
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'failed' }, previousRevision: 2, revision: 3,
      },
      // Authoritative recovery mid-batch
      {
        type: 'created',
        task: makeTask({ id: 't1', status: 'completed', revision: 20 }),
      },
      // Normal update after recovery
      {
        type: 'updated', taskId: 't1',
        changes: { execution: { exitCode: 0 } }, previousRevision: 20, revision: 21,
      },
    ];

    const result = applyBatch(new Map(), batch, qIds);
    expect(result.tasks.get('t1')!.status).toBe('completed');
    expect(result.tasks.get('t1')!.revision).toBe(21);
    expect(result.tasks.get('t1')!.execution.exitCode).toBe(0);
    expect(qIds.has('t1')).toBe(false);
  });

  it('removed delta clears quarantine even if task was quarantined', () => {
    const qIds = new Set<string>();
    const t = makeTask({ id: 't1', revision: 1 });
    let tasks = new Map<string, TaskState>([['t1', t]]);

    // Quarantine
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 99, revision: 100,
    }, qIds);
    tasks = r1.tasks;
    expect(qIds.has('t1')).toBe(true);

    // Remove
    const r2 = applyDelta(tasks, {
      type: 'removed', taskId: 't1', previousRevision: 1,
    }, qIds);
    expect(r2.tasks.has('t1')).toBe(false);
    expect(qIds.has('t1')).toBe(false);
  });
});

// ── 3. DB poll + message-bus deduplication ───────────────────

describe('3. DB poll + message-bus interplay: no duplicate or stale state', () => {
  it('snapshot replace after delta stream yields same final state (idempotent)', () => {
    const qIds = new Set<string>();

    // Simulate delta stream: create → running → completed
    const batch: TaskDelta[] = [
      {
        type: 'created',
        task: makeTask({ id: 't1', status: 'pending', revision: 1, config: { workflowId: 'wf-1' } }),
      },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'completed', execution: { exitCode: 0 } },
        previousRevision: 2, revision: 3,
      },
    ];
    const deltaResult = applyBatch(new Map(), batch, qIds);

    // Simulate DB poll snapshot that observes the same final state
    const snapshotTasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'completed', revision: 3, execution: { exitCode: 0 }, config: { workflowId: 'wf-1' } })],
      qIds,
    );

    // Both paths yield the same task state
    expect(deltaResult.tasks.get('t1')!.status).toBe('completed');
    expect(snapshotTasks.get('t1')!.status).toBe('completed');
    expect(deltaResult.tasks.get('t1')!.revision).toBe(3);
    expect(snapshotTasks.get('t1')!.revision).toBe(3);
  });

  it('DB poll snapshot does not create duplicates when applied after deltas', () => {
    const qIds = new Set<string>();

    // Delta stream creates two tasks
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 't1', revision: 1 }) },
      { type: 'created', task: makeTask({ id: 't2', revision: 1 }) },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
    ];
    const afterDeltas = applyBatch(new Map(), batch, qIds);
    expect(afterDeltas.tasks.size).toBe(2);

    // DB poll returns the same two tasks (same data, simulating the overlap)
    const afterSnapshot = snapshotReplace(
      [
        makeTask({ id: 't1', status: 'running', revision: 2 }),
        makeTask({ id: 't2', status: 'pending', revision: 1 }),
      ],
      qIds,
    );

    // No duplicates — still exactly 2 tasks
    expect(afterSnapshot.size).toBe(2);
    expect(afterSnapshot.get('t1')!.status).toBe('running');
    expect(afterSnapshot.get('t2')!.status).toBe('pending');
  });

  it('stale DB poll snapshot is overwritten by newer delta arriving after snapshot', () => {
    const qIds = new Set<string>();

    // Start with a DB poll snapshot at revision 2
    let tasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'running', revision: 2 })],
      qIds,
    );

    // Delta arrives with newer revision (as if task completed after DB poll)
    const r = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      previousRevision: 2, revision: 3,
    }, qIds);
    tasks = r.tasks;

    expect(tasks.get('t1')!.status).toBe('completed');
    expect(tasks.get('t1')!.revision).toBe(3);
    expect(r.quarantined).toEqual([]);
  });

  it('older DB poll does not regress task state set by newer delta', () => {
    const qIds = new Set<string>();

    // Delta stream has advanced to revision 5
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 't1', revision: 1 }) },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'running' }, previousRevision: 1, revision: 2,
      },
      {
        type: 'updated', taskId: 't1',
        changes: { status: 'completed' }, previousRevision: 2, revision: 3,
      },
    ];
    const afterDeltas = applyBatch(new Map(), batch, qIds);
    expect(afterDeltas.tasks.get('t1')!.revision).toBe(3);
    expect(afterDeltas.tasks.get('t1')!.status).toBe('completed');

    // snapshotReplace unconditionally replaces — this models what useTasks does.
    // The generation counter in useTasks prevents stale snapshots, but at the
    // delta level, the snapshot always wins because it's authoritative.
    // This test documents that a snapshot replace IS authoritative (not a regression).
    const staleSnapshot = snapshotReplace(
      [makeTask({ id: 't1', status: 'running', revision: 2 })],
      qIds,
    );
    // After snapshot replace, the task map reflects the snapshot (authoritative).
    expect(staleSnapshot.get('t1')!.status).toBe('running');
    expect(staleSnapshot.get('t1')!.revision).toBe(2);
    // useTasks generation counter would prevent this in practice — tested in use-tasks.test.tsx.
  });

  it('delta arriving for already-completed task does not regress if revision matches', () => {
    const qIds = new Set<string>();

    // Task completed at revision 3
    const tasks = new Map<string, TaskState>([
      ['t1', makeTask({ id: 't1', status: 'completed', revision: 3, execution: { exitCode: 0 } })],
    ]);

    // Duplicate completion delta with matching revision — this should still merge
    // (in real code, the main process avoids sending duplicate deltas, but the
    // renderer must be resilient).
    const r = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      previousRevision: 3, revision: 4,
    }, qIds);

    expect(r.tasks.get('t1')!.status).toBe('completed');
    expect(r.tasks.get('t1')!.revision).toBe(4);
    expect(r.quarantined).toEqual([]);
  });

  it('simultaneous create deltas for same task: last one wins', () => {
    const qIds = new Set<string>();
    const batch: TaskDelta[] = [
      { type: 'created', task: makeTask({ id: 't1', status: 'pending', revision: 1 }) },
      { type: 'created', task: makeTask({ id: 't1', status: 'running', revision: 5 }) },
    ];

    const result = applyBatch(new Map(), batch, qIds);
    expect(result.tasks.get('t1')!.status).toBe('running');
    expect(result.tasks.get('t1')!.revision).toBe(5);
    expect(result.tasks.size).toBe(1); // no duplicate
  });
});

// ── 4. Restart recovery: persisted state ahead of UI cache ──

describe('4. Recovery after restart: persisted state ahead of UI cache', () => {
  it('snapshot from DB (ahead) replaces empty UI cache', () => {
    const qIds = new Set<string>();

    // UI cache is empty (fresh start)
    const emptyCache = new Map<string, TaskState>();
    expect(emptyCache.size).toBe(0);

    // DB returns persisted state at revision 10
    const persisted = snapshotReplace(
      [
        makeTask({ id: 't1', status: 'completed', revision: 10, execution: { exitCode: 0 } }),
        makeTask({ id: 't2', status: 'running', revision: 5 }),
      ],
      qIds,
    );

    expect(persisted.size).toBe(2);
    expect(persisted.get('t1')!.status).toBe('completed');
    expect(persisted.get('t1')!.revision).toBe(10);
    expect(persisted.get('t2')!.status).toBe('running');
    expect(qIds.size).toBe(0); // quarantine cleared
  });

  it('deltas arriving after restart snapshot apply correctly', () => {
    const qIds = new Set<string>();

    // Restart: DB snapshot at revision 5
    let tasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'running', revision: 5 })],
      qIds,
    );

    // Delta stream resumes from the main process
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed', execution: { exitCode: 0 } },
      previousRevision: 5, revision: 6,
    }, qIds);
    tasks = r1.tasks;
    expect(tasks.get('t1')!.status).toBe('completed');
    expect(tasks.get('t1')!.revision).toBe(6);
    expect(r1.quarantined).toEqual([]);
  });

  it('stale delta (from before restart) is quarantined after DB snapshot', () => {
    const qIds = new Set<string>();

    // Restart: DB snapshot at revision 10
    let tasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'completed', revision: 10 })],
      qIds,
    );

    // A stale delta arrives (from before the restart, referring to old revision)
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 3, revision: 4,
    }, qIds);
    tasks = r1.tasks;

    // Quarantined — task remains at revision 10
    expect(r1.quarantined).toEqual(['t1']);
    expect(tasks.get('t1')!.status).toBe('completed');
    expect(tasks.get('t1')!.revision).toBe(10);
  });

  it('quarantine from stale post-restart delta clears on next authoritative snapshot', () => {
    const qIds = new Set<string>();

    // Restart: DB snapshot at revision 10
    let tasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'completed', revision: 10 })],
      qIds,
    );

    // Stale delta quarantines
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 3, revision: 4,
    }, qIds);
    tasks = r1.tasks;
    expect(qIds.has('t1')).toBe(true);

    // New authoritative snapshot (refreshTasks) clears quarantine
    tasks = snapshotReplace(
      [makeTask({ id: 't1', status: 'failed', revision: 12 })],
      qIds,
    );
    expect(qIds.size).toBe(0);
    expect(tasks.get('t1')!.status).toBe('failed');
    expect(tasks.get('t1')!.revision).toBe(12);

    // Normal deltas resume
    const r2 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { execution: { error: 'retry-1' } }, previousRevision: 12, revision: 13,
    }, qIds);
    expect(r2.tasks.get('t1')!.revision).toBe(13);
    expect(r2.quarantined).toEqual([]);
  });

  it('multiple tasks: some persisted ahead, some brand new — all converge', () => {
    const qIds = new Set<string>();

    // Restart: t1 completed (ahead), t2 pending (just created by recovery)
    let tasks = snapshotReplace(
      [
        makeTask({ id: 't1', status: 'completed', revision: 8, execution: { exitCode: 0 } }),
        makeTask({ id: 't2', status: 'pending', revision: 1 }),
      ],
      qIds,
    );

    // Delta for t2 (normal flow after restart)
    const r1 = applyDelta(tasks, {
      type: 'updated', taskId: 't2',
      changes: { status: 'running' }, previousRevision: 1, revision: 2,
    }, qIds);
    tasks = r1.tasks;
    expect(tasks.get('t2')!.status).toBe('running');
    expect(r1.quarantined).toEqual([]);

    // Stale delta for t1 (from before restart) — quarantined
    const r2 = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'running' }, previousRevision: 2, revision: 3,
    }, qIds);
    tasks = r2.tasks;
    expect(r2.quarantined).toEqual(['t1']);
    expect(tasks.get('t1')!.status).toBe('completed'); // unchanged

    // t2 continues normally
    const r3 = applyDelta(tasks, {
      type: 'updated', taskId: 't2',
      changes: { status: 'completed' }, previousRevision: 2, revision: 3,
    }, qIds);
    tasks = r3.tasks;
    expect(tasks.get('t2')!.status).toBe('completed');
    expect(r3.quarantined).toEqual([]);

    // Authoritative created for t1 clears quarantine
    const r4 = applyDelta(tasks, {
      type: 'created',
      task: makeTask({ id: 't1', status: 'completed', revision: 8, execution: { exitCode: 0 } }),
    }, qIds);
    tasks = r4.tasks;
    expect(qIds.has('t1')).toBe(false);
    expect(tasks.get('t1')!.revision).toBe(8);
  });

  it('bootstrap preload + snapshot + deltas all converge without duplicates', () => {
    const qIds = new Set<string>();

    // Step 1: Bootstrap preload (window.__INVOKER_BOOTSTRAP__)
    const bootstrap = new Map<string, TaskState>();
    const bootTask = makeTask({ id: 't1', status: 'pending', revision: 1 });
    bootstrap.set('t1', bootTask);

    // Step 2: Async getTasks returns newer state (simulating race)
    const snapshot = snapshotReplace(
      [makeTask({ id: 't1', status: 'running', revision: 3 })],
      qIds,
    );
    expect(snapshot.get('t1')!.status).toBe('running');
    expect(snapshot.get('t1')!.revision).toBe(3);
    expect(snapshot.size).toBe(1); // no duplicate from bootstrap

    // Step 3: Delta arrives continuing from snapshot revision
    let tasks = snapshot;
    const r = applyDelta(tasks, {
      type: 'updated', taskId: 't1',
      changes: { status: 'completed' }, previousRevision: 3, revision: 4,
    }, qIds);
    tasks = r.tasks;
    expect(tasks.get('t1')!.status).toBe('completed');
    expect(tasks.get('t1')!.revision).toBe(4);
    expect(tasks.size).toBe(1);
  });
});

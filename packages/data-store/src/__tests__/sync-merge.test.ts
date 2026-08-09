import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Attempt, TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { WorkflowSaveInput } from '../adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import { appendJournalEntry, getSyncCursor, readJournalSince } from '../sync-journal.js';
import { exportDelta } from '../sync-delta.js';
import { applyDelta } from '../sync-merge.js';

const T0 = '2026-07-28T00:00:00.000Z';
const T1 = '2026-07-28T00:00:01.000Z';
const T2 = '2026-07-28T00:00:02.000Z';

function executor(adapter: SQLiteAdapter): SqliteExecutor {
  return (adapter as unknown as { executor: SqliteExecutor }).executor;
}

function makeWorkflow(id = 'wf-1'): WorkflowSaveInput {
  return {
    id,
    name: `Workflow ${id}`,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeTask(id = 'task-1', status: TaskState['status'] = 'pending'): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status,
    dependencies: [],
    createdAt: new Date(T0),
    config: {},
    execution: { generation: 0 },
    taskStateVersion: 1,
  };
}

function makeAttempt(id: string, taskId: string, status: Attempt['status']): Attempt {
  return {
    id,
    nodeId: taskId,
    queuePriority: 0,
    status,
    upstreamAttemptIds: [],
    createdAt: new Date(T1),
  };
}

function seed(adapter: SQLiteAdapter, workflowId = 'wf-1', taskId = 'task-1'): void {
  adapter.saveWorkflow(makeWorkflow(workflowId));
  adapter.saveTask(workflowId, makeTask(taskId));
}

function latestRow(db: SqliteExecutor, table: string): Record<string, unknown> {
  const row = db.queryOne(`SELECT * FROM ${table} ORDER BY id DESC LIMIT 1`);
  if (!row) throw new Error(`No rows in ${table}`);
  return row;
}

function insertEventAndJournal(adapter: SQLiteAdapter, taskId: string): void {
  adapter.logEvent(taskId, 'task.progress', { step: 1 });
  const row = latestRow(executor(adapter), 'events');
  appendJournalEntry(executor(adapter), {
    entityType: 'event',
    entityId: String(row.id),
    op: 'upsert',
    payload: row,
  });
}

function insertOutputAndJournal(adapter: SQLiteAdapter, taskId: string): void {
  const db = executor(adapter);
  db.execRun(
    'INSERT INTO output_spool (id, task_id, offset, data, created_at) VALUES (?, ?, ?, ?, ?)',
    [1, taskId, 0, 'hello\n', T1],
  );
  const row = latestRow(db, 'output_spool');
  appendJournalEntry(db, {
    entityType: 'output',
    entityId: String(row.id),
    op: 'upsert',
    payload: row,
  });
}

function exchange(from: SQLiteAdapter, to: SQLiteAdapter, peerId: string): void {
  applyDelta(executor(to), exportDelta(executor(from), 0), peerId);
}

function tableRows(adapter: SQLiteAdapter, table: string): Record<string, unknown>[] {
  return executor(adapter).queryAll(`SELECT * FROM ${table} ORDER BY id ASC`);
}

function graphState(adapter: SQLiteAdapter): Record<string, unknown> {
  const db = executor(adapter);
  return {
    workflows: db.queryAll(
      'SELECT id, name, deleted_at, created_at, updated_at FROM workflows ORDER BY id ASC',
    ),
    tasks: db.queryAll(
      'SELECT id, workflow_id, description, status, dependencies, started_at, completed_at, task_state_version FROM tasks ORDER BY id ASC',
    ),
    attempts: db.queryAll(
      'SELECT id, node_id, status, created_at, completed_at, exit_code, error FROM attempts ORDER BY id ASC',
    ),
    events: db.queryAll(
      'SELECT id, task_id, event_type, payload, created_at FROM events ORDER BY id ASC',
    ),
    output: db.queryAll(
      'SELECT id, task_id, offset, data, created_at FROM output_spool ORDER BY id ASC',
    ),
  };
}

describe('sync merge', () => {
  let a: SQLiteAdapter;
  let b: SQLiteAdapter;

  beforeEach(async () => {
    a = await SQLiteAdapter.create(':memory:');
    b = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    a.close();
    b.close();
  });

  it('converges divergent running vs completed task status to completed', () => {
    seed(a);
    seed(b);

    a.updateTask('task-1', { status: 'running', execution: { startedAt: new Date(T1) } });
    b.updateTask('task-1', { status: 'completed', execution: { completedAt: new Date(T2), exitCode: 0 } });

    exchange(a, b, 'peer-a');
    exchange(b, a, 'peer-b');

    expect(a.loadTask('task-1')?.status).toBe('completed');
    expect(b.loadTask('task-1')?.status).toBe('completed');
    expect(a.loadWorkflow('wf-1')?.status).toBe('completed');
    expect(b.loadWorkflow('wf-1')?.status).toBe('completed');
  });

  it('keeps completed ahead of a partitioned cancel/closed status', () => {
    seed(a);
    seed(b);

    a.updateTask('task-1', { status: 'closed', execution: { completedAt: new Date(T1) } });
    b.updateTask('task-1', { status: 'completed', execution: { completedAt: new Date(T2), exitCode: 0 } });

    exchange(a, b, 'peer-a');
    exchange(b, a, 'peer-b');

    expect(a.loadTask('task-1')?.status).toBe('completed');
    expect(b.loadTask('task-1')?.status).toBe('completed');
  });

  it('keeps tombstones while parking late progress under the soft-deleted workflow', () => {
    seed(a, 'wf-delete', 'task-delete');
    seed(b, 'wf-delete', 'task-delete');

    a.deleteWorkflow('wf-delete');
    b.updateTask('task-delete', { status: 'running', execution: { startedAt: new Date(T1) } });
    b.saveAttempt(makeAttempt('attempt-delete-1', 'task-delete', 'running'));
    insertEventAndJournal(b, 'task-delete');
    insertOutputAndJournal(b, 'task-delete');

    exchange(a, b, 'peer-a');
    expect(b.loadWorkflow('wf-delete')).toBeUndefined();
    expect(b.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
    expect(b.loadTasks('wf-delete').map((task) => task.id)).toEqual(['task-delete']);

    exchange(b, a, 'peer-b');
    expect(a.loadWorkflow('wf-delete')).toBeUndefined();
    expect(a.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
    expect(a.loadTasks('wf-delete')[0]?.status).toBe('running');
    expect(a.loadAttempts('task-delete').map((attempt) => attempt.id)).toEqual(['attempt-delete-1']);
    expect(a.getEvents('task-delete').map((event) => event.eventType)).toEqual(['task.progress']);
    expect(tableRows(a, 'output_spool')).toMatchObject([{ task_id: 'task-delete', offset: 0, data: 'hello\n' }]);

    exchange(a, b, 'peer-a');
    expect(b.loadWorkflow('wf-delete')).toBeUndefined();
    expect(b.loadTasks('wf-delete')[0]?.status).toBe('running');
    expect(b.getEvents('task-delete')).toHaveLength(1);
  });

  it('applies duplicate delivery idempotently', () => {
    seed(a);
    seed(b);
    a.updateTask('task-1', { status: 'running', execution: { startedAt: new Date(T1) } });
    insertEventAndJournal(a, 'task-1');

    const batch = exportDelta(executor(a), 0);
    const first = applyDelta(executor(b), batch, 'peer-a');
    const second = applyDelta(executor(b), batch, 'peer-a');

    expect(first.appliedEntries).toBeGreaterThan(0);
    expect(second.appliedEntries).toBe(0);
    expect(b.loadTask('task-1')?.status).toBe('running');
    expect(b.getEvents('task-1')).toHaveLength(1);
    expect(readJournalSince(executor(b), 0, 100).filter((entry) => entry.origin === 'peer-a')).toHaveLength(
      first.appliedEntries,
    );
  });

  it('exports only local-origin entries so imported rows are not echoed', () => {
    seed(a);
    seed(b);
    a.updateTask('task-1', { status: 'running' });

    applyDelta(executor(b), exportDelta(executor(a), 0), 'peer-a');

    const echoed = exportDelta(executor(b), 0);
    expect(echoed.entries).toEqual([]);
    expect(echoed.highWaterSeq).toBeGreaterThan(0);
    expect(readJournalSince(executor(b), 0, 100).map((entry) => entry.origin)).toEqual(['peer-a']);
  });

  it('rejects unsupported delta schema versions', () => {
    seed(a);
    seed(b);
    a.updateTask('task-1', { status: 'running' });
    const batch = exportDelta(executor(a), 0);

    expect(() =>
      applyDelta(executor(b), { ...batch, schemaVersion: 999 as 1 }, 'peer-a'),
    ).toThrow(/Unsupported delta schema version 999/);
    expect(getSyncCursor(executor(b), 'peer-a')).toBeUndefined();
    expect(b.loadTask('task-1')?.status).toBe('pending');
  });

  it('updates the peer receive cursor atomically with the applied delta', () => {
    seed(a);
    seed(b);
    a.updateTask('task-1', { status: 'running' });

    const batch = exportDelta(executor(a), 0);
    applyDelta(executor(b), batch, 'peer-a');

    expect(getSyncCursor(executor(b), 'peer-a')?.lastReceivedSeq).toBe(batch.highWaterSeq);
  });

  it('round-trips A to B to A and converges both stores to identical graph state', () => {
    seed(a);
    seed(b);

    a.updateTask('task-1', { status: 'running', execution: { startedAt: new Date(T1) } });
    b.updateTask('task-1', { status: 'completed', execution: { completedAt: new Date(T2), exitCode: 0 } });
    b.saveAttempt(makeAttempt('attempt-1', 'task-1', 'completed'));
    insertEventAndJournal(b, 'task-1');
    insertOutputAndJournal(b, 'task-1');

    exchange(a, b, 'peer-a');
    exchange(b, a, 'peer-b');

    expect(graphState(a)).toEqual(graphState(b));
  });
});

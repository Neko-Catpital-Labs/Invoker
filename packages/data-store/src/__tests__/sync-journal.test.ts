import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

function executor(adapter: SQLiteAdapter): SqliteExecutor {
  return (adapter as unknown as { executor: SqliteExecutor }).executor;
}

function workflow(id = 'wf-1'): Workflow {
  return {
    id,
    name: id,
    status: 'pending',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function task(id: string, workflowId = 'wf-1'): TaskState {
  return {
    id,
    description: id,
    status: 'pending',
    dependencies: [],
    createdAt: new Date('2026-07-27T00:00:00.000Z'),
    config: { workflowId },
    execution: {},
    taskStateVersion: 1,
  };
}

function latestSeq(db: SqliteExecutor): number {
  const row = db.queryOne('SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_journal');
  return Number(row?.seq ?? 0);
}

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('rolls back journal entries with the mutation that produced them', () => {
    adapter.saveWorkflow(workflow());
    adapter.saveTask('wf-1', task('wf-1/t1'));
    const db = executor(adapter);
    const beforeSeq = latestSeq(db);

    expect(() => adapter.runInTransaction(() => {
      adapter.updateTask('wf-1/t1', { status: 'running' });
      throw new Error('rollback task status');
    })).toThrow('rollback task status');

    expect(adapter.loadTask('wf-1/t1')?.status).toBe('pending');
    expect(readJournalSince(db, beforeSeq, 10)).toEqual([]);
  });

  it('assigns strictly monotonic journal sequence numbers', () => {
    const db = executor(adapter);
    const first = appendJournalEntry(db, {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(db, {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a' },
    });
    const third = appendJournalEntry(db, {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a' },
    });

    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
  });

  it('reads journal rows after a cursor and persists peer cursor pairs', () => {
    const db = executor(adapter);
    const first = appendJournalEntry(db, {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(db, {
      entityType: 'workflow',
      entityId: 'wf-b',
      op: 'upsert',
      payload: { id: 'wf-b' },
    });
    const third = appendJournalEntry(db, {
      entityType: 'workflow',
      entityId: 'wf-c',
      op: 'upsert',
      payload: { id: 'wf-c' },
    });

    const cursor = setSyncCursor(db, {
      peerId: 'remote-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 42,
      updatedAt: '2026-07-27T01:00:00.000Z',
    });

    expect(cursor).toEqual({
      peerId: 'remote-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 42,
      updatedAt: '2026-07-27T01:00:00.000Z',
    });
    expect(getSyncCursor(db, 'remote-a')).toEqual(cursor);
    expect(readJournalSince(db, first.seq, 1).map((entry) => entry.seq)).toEqual([second.seq]);
    expect(readJournalSince(db, cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([third.seq]);
  });

  it('journals attempt creation and completion snapshots', () => {
    adapter.saveWorkflow(workflow());
    adapter.saveTask('wf-1', task('wf-1/t1'));
    const db = executor(adapter);
    const beforeSeq = latestSeq(db);
    const attempt = createAttempt('wf-1/t1', { status: 'running' });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T02:00:00.000Z'),
      exitCode: 0,
      summary: 'done',
    });

    const attempts = readJournalSince(db, beforeSeq, 10)
      .filter((entry) => entry.entityType === 'attempt');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({ entityId: attempt.id, op: 'upsert' });
    expect(attempts[0].payload).toMatchObject({ id: attempt.id, status: 'running' });
    expect(attempts[1].payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      completed_at: '2026-07-27T02:00:00.000Z',
      exit_code: 0,
      summary: 'done',
    });
  });

  it('soft deletes workflows by default and writes a tombstone journal entry', () => {
    adapter.saveWorkflow(workflow('wf-delete'));
    adapter.saveTask('wf-delete', task('wf-delete/t1', 'wf-delete'));
    const db = executor(adapter);
    const beforeDeleteSeq = latestSeq(db);

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    const [deletedWorkflow] = adapter.listWorkflows({ includeDeleted: true });
    expect(deletedWorkflow).toMatchObject({
      id: 'wf-delete',
      name: 'wf-delete',
    });
    expect(deletedWorkflow.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt)
      .toBe(deletedWorkflow.deletedAt);

    const tombstones = readJournalSince(db, beforeDeleteSeq, 10)
      .filter((entry) => entry.entityType === 'workflow' && entry.op === 'tombstone');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entityId: 'wf-delete',
      origin: 'home',
    });
    expect(tombstones[0].payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: deletedWorkflow.deletedAt,
    });
  });
});

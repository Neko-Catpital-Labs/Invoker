import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import type { SqliteExecutor } from '../sqlite-executor.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;
  let exec: SqliteExecutor;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    exec = (adapter as any).executor as SqliteExecutor;
  });

  afterEach(() => {
    adapter.close();
  });

  function workflow(id: string) {
    return {
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  function task(id: string, status: TaskState['status'] = 'pending'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status,
      dependencies: [],
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal rows with the mutation transaction', () => {
    expect(() =>
      exec.runTransaction(() => {
        exec.execRun(
          `INSERT INTO workflows (id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          ['wf-rollback', 'Rollback', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z'],
        );
        appendJournalEntry(exec, {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: { id: 'wf-rollback' },
        });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(exec, 0, 10)).toEqual([]);
  });

  it('fails the enclosing mutation when a journal write fails', () => {
    (adapter as any).db.run(`
      CREATE TRIGGER fail_sync_journal_insert
      BEFORE INSERT ON sync_journal
      BEGIN
        SELECT RAISE(FAIL, 'journal fail');
      END
    `);

    expect(() => adapter.saveWorkflow(workflow('wf-fail'))).toThrow(/journal fail/);
    expect(adapter.loadWorkflow('wf-fail', { includeDeleted: true })).toBeUndefined();

    (adapter as any).db.run('DROP TRIGGER fail_sync_journal_insert');
    expect(readJournalSince(exec, 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values for adapter-journaled mutations', () => {
    adapter.saveWorkflow(workflow('wf-seq'));
    adapter.saveTask('wf-seq', task('t-seq'));
    adapter.updateTask('t-seq', { status: 'running' });
    const attempt = {
      ...createAttempt('t-seq', { status: 'running' }),
      createdAt: new Date('2026-07-27T00:00:01.000Z'),
    };
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:00:02.000Z'),
    });

    const rows = adapter.readJournalSince(0, 20);
    expect(rows.map((row) => [row.entityType, row.entityId, row.op])).toEqual([
      ['workflow', 'wf-seq', 'upsert'],
      ['task', 't-seq', 'upsert'],
      ['task', 't-seq', 'upsert'],
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads journal entries after the supplied cursor and stores peer cursors', () => {
    const first = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
      createdAt: 1,
    });
    const second = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-2',
      op: 'upsert',
      payload: { id: 'wf-2' },
      createdAt: 2,
    });
    appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-3',
      op: 'upsert',
      payload: { id: 'wf-3' },
      createdAt: 3,
    });

    const cursor = setSyncCursor(exec, {
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: first.seq,
      updatedAt: 4,
    });

    expect(getSyncCursor(exec, 'peer-a')).toEqual(cursor);
    expect(readJournalSince(exec, cursor.lastSentSeq, 10).map((row) => row.entityId)).toEqual(['wf-3']);
    expect(readJournalSince(exec, first.seq, 1).map((row) => row.entityId)).toEqual(['wf-2']);
  });

  it('excludes soft-deleted workflows by default but includes them when requested', () => {
    adapter.saveWorkflow(workflow('wf-deleted'));
    adapter.saveWorkflow(workflow('wf-live'));

    adapter.deleteWorkflow('wf-deleted');

    expect(adapter.loadWorkflow('wf-deleted')).toBeUndefined();
    expect(adapter.listWorkflows().map((row) => row.id)).toEqual(['wf-live']);

    const all = adapter.listWorkflows({ includeDeleted: true });
    const deleted = all.find((row) => row.id === 'wf-deleted');
    expect(all.map((row) => row.id).sort()).toEqual(['wf-deleted', 'wf-live']);
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = adapter.readJournalSince(0, 10).find((row) => row.op === 'tombstone');
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: 'home',
    });
    expect(tombstone?.payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

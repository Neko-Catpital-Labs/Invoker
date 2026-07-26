import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
  type SyncJournalDatabase,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function journalDb(): SyncJournalDatabase {
    return (adapter as unknown as { executor: SyncJournalDatabase }).executor;
  }

  function makeWorkflow(id = 'wf-1'): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    };
  }

  function makeTask(id = 't1'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  function maxJournalSeq(): number {
    const row = journalDb().queryOne('SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_journal');
    return Number(row?.seq ?? 0);
  }

  it('rolls journal appends back with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    const beforeSeq = maxJournalSeq();

    expect(() => {
      adapter.runInTransaction(() => {
        adapter.updateTask('t1', { status: 'running' });
        throw new Error('simulated rollback');
      });
    }).toThrow('simulated rollback');

    expect(adapter.loadTask('t1')?.status).toBe('pending');
    expect(readJournalSince(journalDb(), beforeSeq, 10)).toEqual([]);
  });

  it('fails the mutation transaction loudly when the journal append fails', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    const beforeSeq = maxJournalSeq();

    const rawDb = (adapter as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
    const originalRun = rawDb.run.bind(rawDb);
    rawDb.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('simulated journal failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => adapter.updateTask('t1', { status: 'running' })).toThrow('simulated journal failure');
    } finally {
      rawDb.run = originalRun;
    }

    expect(adapter.loadTask('t1')?.status).toBe('pending');
    expect(readJournalSince(journalDb(), beforeSeq, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values', () => {
    const first = appendJournalEntry(journalDb(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(journalDb(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(journalDb(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    expect([first.seq, second.seq, third.seq]).toEqual([
      first.seq,
      first.seq + 1,
      first.seq + 2,
    ]);
  });

  it('reads journal rows after a cursor and persists cursor pairs', () => {
    const first = appendJournalEntry(journalDb(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(journalDb(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });

    const cursor = setSyncCursor(journalDb(), {
      peerId: 'remote-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 42,
      updatedAt: 1234,
    });

    expect(getSyncCursor(journalDb(), 'remote-a')).toEqual(cursor);
    expect(readJournalSince(journalDb(), cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      second.seq,
    ]);
    expect(readJournalSince(journalDb(), 0, 1).map((entry) => entry.seq)).toEqual([
      first.seq,
    ]);
  });

  it('excludes soft-deleted workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    adapter.saveTask('wf-delete', makeTask('wf-delete/t1'));
    const beforeSeq = maxJournalSeq();

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    expect(adapter.listWorkflows().map((workflow) => workflow.id)).not.toContain('wf-delete');

    const deleted = adapter
      .listWorkflows({ includeDeleted: true })
      .find((workflow) => workflow.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));

    const entries = readJournalSince(journalDb(), beforeSeq, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entries[0].payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: deleted!.deletedAt,
    });
  });

  it('journals attempt creation and completion snapshots', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    const beforeSeq = maxJournalSeq();
    const attempt = createAttempt('t1', { status: 'running' });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T00:01:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(journalDb(), beforeSeq, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(entries[1].payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      completed_at: '2026-07-26T00:01:00.000Z',
    });
  });
});

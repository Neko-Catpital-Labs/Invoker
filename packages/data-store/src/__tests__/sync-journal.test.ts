import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { createAttempt } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
  type SyncJournalDb,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function journalDb(): SyncJournalDb {
    return (adapter as unknown as { executor: SyncJournalDb }).executor;
  }

  function makeWorkflow(id: string, createdAt = '2026-07-01T00:00:00.000Z'): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    };
  }

  function makeTask(id: string, workflowId: string, status: TaskState['status'] = 'pending'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status,
      dependencies: [],
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      config: { workflowId },
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal entries with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(makeWorkflow('wf-rollback'));
    adapter.saveTask('wf-rollback', makeTask('task-rollback', 'wf-rollback'));

    expect(() => adapter.runInTransaction(() => {
      adapter.updateTask('task-rollback', { status: 'running' });
      throw new Error('rollback requested');
    })).toThrow('rollback requested');

    expect(adapter.loadTask('task-rollback')?.status).toBe('pending');
    expect(readJournalSince(journalDb(), 0, 10)).toEqual([]);
  });

  it('fails loudly and rolls back the mutation when a journal append fails', () => {
    adapter.saveWorkflow(makeWorkflow('wf-failure'));
    adapter.saveTask('wf-failure', makeTask('task-failure', 'wf-failure'));

    const db = (adapter as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
    const originalRun = db.run;
    db.run = function runWithJournalFailure(sql: string, params?: unknown[]): void {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('journal insert failed');
      }
      return originalRun.call(this, sql, params);
    };

    try {
      expect(() => adapter.updateTask('task-failure', { status: 'running' }))
        .toThrow('journal insert failed');
    } finally {
      db.run = originalRun;
    }

    expect(adapter.loadTask('task-failure')?.status).toBe('pending');
    expect(readJournalSince(journalDb(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic journal sequences', () => {
    const seqs = [
      appendJournalEntry(journalDb(), {
        entityType: 'task',
        entityId: 'task-1',
        op: 'upsert',
        payload: { id: 'task-1' },
      }),
      appendJournalEntry(journalDb(), {
        entityType: 'attempt',
        entityId: 'attempt-1',
        op: 'upsert',
        payload: { id: 'attempt-1' },
      }),
      appendJournalEntry(journalDb(), {
        entityType: 'event',
        entityId: 'event-1',
        op: 'upsert',
        payload: { id: 1 },
      }),
    ];

    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
    expect(readJournalSince(journalDb(), 0, 10).map((entry) => entry.seq)).toEqual(seqs);
  });

  it('reads journal rows after the cursor and persists cursor pairs', () => {
    const firstSeq = appendJournalEntry(journalDb(), {
      entityType: 'task',
      entityId: 'task-cursor-1',
      op: 'upsert',
      payload: { id: 'task-cursor-1' },
    });
    const secondSeq = appendJournalEntry(journalDb(), {
      entityType: 'task',
      entityId: 'task-cursor-2',
      op: 'upsert',
      payload: { id: 'task-cursor-2' },
    });
    const thirdSeq = appendJournalEntry(journalDb(), {
      entityType: 'task',
      entityId: 'task-cursor-3',
      op: 'upsert',
      payload: { id: 'task-cursor-3' },
    });

    setSyncCursor(journalDb(), {
      peerId: 'peer-a',
      lastSentSeq: secondSeq,
      lastReceivedSeq: firstSeq,
      updatedAt: 123,
    });
    expect(getSyncCursor(journalDb(), 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: secondSeq,
      lastReceivedSeq: firstSeq,
      updatedAt: 123,
    });

    const unread = readJournalSince(journalDb(), getSyncCursor(journalDb(), 'peer-a')!.lastSentSeq, 10);
    expect(unread.map((entry) => entry.seq)).toEqual([thirdSeq]);
    expect(readJournalSince(journalDb(), secondSeq, 0)).toEqual([]);

    setSyncCursor(journalDb(), 'peer-a', { lastReceivedSeq: thirdSeq, updatedAt: 456 });
    expect(getSyncCursor(journalDb(), 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: secondSeq,
      lastReceivedSeq: thirdSeq,
      updatedAt: 456,
    });
  });

  it('excludes soft-deleted workflows from default listings and includes them explicitly', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete', '2026-07-01T00:00:00.000Z'));
    adapter.saveWorkflow(makeWorkflow('wf-live', '2026-07-02T00:00:00.000Z'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-live']);

    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt)
      .toEqual(expect.any(Number));
    const deleted = adapter.listWorkflows({ includeDeleted: true })
      .find((workflow) => workflow.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    adapter.saveWorkflow(makeWorkflow('wf-tombstone'));
    adapter.saveTask('wf-tombstone', makeTask('task-tombstone', 'wf-tombstone'));
    const attempt = createAttempt('task-tombstone', { status: 'running' });
    adapter.saveAttempt(attempt);
    const lastSeedSeq = readJournalSince(journalDb(), 0, 10).at(-1)?.seq ?? 0;

    adapter.deleteWorkflow('wf-tombstone');

    const [entry] = readJournalSince(journalDb(), lastSeedSeq, 10);
    expect(entry).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entry.payload).toEqual(expect.objectContaining({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    }));
  });
});

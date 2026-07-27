import { afterEach, describe, expect, it } from 'vitest';
import type { WorkflowSaveInput } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
  type SyncJournalDatabase,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter | undefined;

  afterEach(() => {
    adapter?.close();
    adapter = undefined;
  });

  async function createAdapter(): Promise<SQLiteAdapter> {
    adapter = await SQLiteAdapter.create(':memory:');
    return adapter;
  }

  function journalDb(db: SQLiteAdapter): SyncJournalDatabase {
    return (db as unknown as { executor: SyncJournalDatabase }).executor;
  }

  function workflow(id: string): WorkflowSaveInput {
    return {
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    };
  }

  it('rolls back journal appends with the enclosing mutation transaction', async () => {
    const db = await createAdapter();
    const syncDb = journalDb(db);

    expect(() => {
      db.runInTransaction(() => {
        db.saveWorkflow(workflow('wf-rollback'));
        const row = syncDb.queryOne('SELECT * FROM workflows WHERE id = ?', ['wf-rollback']);
        appendJournalEntry(syncDb, {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: row,
        });
        throw new Error('rollback requested');
      });
    }).toThrow('rollback requested');

    expect(db.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(syncDb, 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values', async () => {
    const db = await createAdapter();
    const syncDb = journalDb(db);

    const first = appendJournalEntry(syncDb, {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
    });
    const second = appendJournalEntry(syncDb, {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const third = appendJournalEntry(syncDb, {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1' },
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
    expect(readJournalSince(syncDb, 0, 10).map((entry) => entry.seq)).toEqual([
      first.seq,
      second.seq,
      third.seq,
    ]);
  });

  it('reads journal entries after the supplied cursor', async () => {
    const db = await createAdapter();
    const syncDb = journalDb(db);

    appendJournalEntry(syncDb, {
      entityType: 'workflow',
      entityId: 'wf-before',
      op: 'upsert',
      payload: { id: 'wf-before' },
    });
    const cursorEntry = appendJournalEntry(syncDb, {
      entityType: 'task',
      entityId: 'task-cursor',
      op: 'upsert',
      payload: { id: 'task-cursor' },
    });
    const afterCursor = appendJournalEntry(syncDb, {
      entityType: 'attempt',
      entityId: 'attempt-after',
      op: 'upsert',
      payload: { id: 'attempt-after' },
    });

    const cursor = setSyncCursor(syncDb, 'peer-a', {
      lastSentSeq: cursorEntry.seq,
      lastReceivedSeq: 7,
    });

    expect(getSyncCursor(syncDb, 'peer-a')).toMatchObject({
      peerId: 'peer-a',
      lastSentSeq: cursorEntry.seq,
      lastReceivedSeq: 7,
    });
    expect(readJournalSince(syncDb, cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      afterCursor.seq,
    ]);
  });

  it('excludes soft-deleted workflows by default and reads them with includeDeleted', async () => {
    const db = await createAdapter();

    db.saveWorkflow(workflow('wf-soft-delete'));
    db.deleteWorkflow('wf-soft-delete');

    expect(db.listWorkflows()).toEqual([]);
    expect(db.loadWorkflow('wf-soft-delete')).toBeUndefined();

    const [deleted] = db.listWorkflows({ includeDeleted: true });
    expect(deleted.id).toBe('wf-soft-delete');
    expect(deleted.deletedAt).toEqual(expect.any(Number));
    expect(db.loadWorkflow('wf-soft-delete', { includeDeleted: true })?.deletedAt)
      .toEqual(expect.any(Number));
  });

  it('writes a workflow tombstone journal entry on delete', async () => {
    const db = await createAdapter();
    const syncDb = journalDb(db);

    db.saveWorkflow(workflow('wf-tombstone'));
    db.deleteWorkflow('wf-tombstone');

    const entries = readJournalSince(syncDb, 0, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entries[0].payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  const workflow: Workflow = {
    id: 'wf-sync',
    name: 'Sync Workflow',
    status: 'pending',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };

  function executor(): SqliteExecutor {
    return (adapter as any).executor as SqliteExecutor;
  }

  function scalar(sql: string): number {
    const row = (adapter as any).queryOne(sql) as { c?: number } | undefined;
    return Number(row?.c ?? 0);
  }

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  it('rolls back journal appends with the enclosing mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        (adapter as any).db.run(
          `INSERT INTO workflows (id, name, created_at, updated_at)
           VALUES ('wf-rollback', 'Rollback', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`,
        );
        appendJournalEntry(executor(), {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: { id: 'wf-rollback' },
        });
        throw new Error('rollback sentinel');
      });
    }).toThrow('rollback sentinel');

    expect(scalar("SELECT COUNT(*) AS c FROM workflows WHERE id = 'wf-rollback'")).toBe(0);
    expect(scalar('SELECT COUNT(*) AS c FROM sync_journal')).toBe(0);
  });

  it('fails the mutation transaction loudly when the journal insert fails', () => {
    adapter.saveWorkflow(workflow);
    adapter.saveTask('wf-sync', makeTask('task-sync'));

    const db = (adapter as any).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, ...args: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('journal disk failure');
      }
      return originalRun(sql, ...args);
    };

    expect(() => adapter.updateTask('task-sync', { status: 'running' })).toThrow('journal disk failure');
    db.run = originalRun;

    expect(adapter.loadTask('task-sync')?.status).toBe('pending');
    expect(scalar('SELECT COUNT(*) AS c FROM sync_journal')).toBe(0);
  });

  it('allocates strictly monotonic journal seq values', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1' },
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
    expect(readJournalSince(executor(), 0, 10).map((entry) => entry.seq)).toEqual([
      first.seq,
      second.seq,
      third.seq,
    ]);
  });

  it('reads journal entries after the stored peer cursor', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1' },
    });

    setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: first.seq,
      updatedAt: '2026-07-27T00:00:01.000Z',
    });

    const cursor = getSyncCursor(executor(), 'peer-a');
    expect(cursor).toMatchObject({
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: first.seq,
    });
    expect(readJournalSince(executor(), cursor!.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      third.seq,
    ]);
  });

  it('excludes soft-deleted workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow(workflow);
    adapter.deleteWorkflow('wf-sync');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-sync')).toBeUndefined();

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      id: 'wf-sync',
      name: 'Sync Workflow',
    });
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-sync', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when a workflow is deleted', () => {
    adapter.saveWorkflow(workflow);
    adapter.saveTask('wf-sync', makeTask('task-sync'));
    const attempt = createAttempt('task-sync', { status: 'pending' });
    adapter.saveAttempt(attempt);

    const beforeDelete = readJournalSince(executor(), 0, 10).at(-1)?.seq ?? 0;
    adapter.deleteWorkflow('wf-sync');

    const entries = readJournalSince(executor(), beforeDelete, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-sync',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entries[0].payload).toMatchObject({
      id: 'wf-sync',
      deleted_at: expect.any(Number),
    });
  });

  it('journals task status changes and attempt creation/completion snapshots', () => {
    adapter.saveWorkflow(workflow);
    adapter.saveTask('wf-sync', makeTask('task-sync'));
    const attempt = createAttempt('task-sync', { status: 'pending' });

    adapter.updateTask('task-sync', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:00:02.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(executor(), 0, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['task', 'task-sync', 'upsert'],
      ['workflow', 'wf-sync', 'upsert'],
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(entries.at(-1)?.payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      completed_at: '2026-07-27T00:00:02.000Z',
    });
  });
});

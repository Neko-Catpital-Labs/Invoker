import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
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

  function executor(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function latestSeq(): number {
    const row = executor().queryOne('SELECT COALESCE(MAX(seq), 0) AS seq FROM sync_journal');
    return Number(row?.seq ?? 0);
  }

  function saveWorkflow(id = 'wf-1'): void {
    const now = '2026-07-28T00:00:00.000Z';
    adapter.saveWorkflow({
      id,
      name: `Workflow ${id}`,
      createdAt: now,
      updatedAt: now,
    });
  }

  function saveTask(workflowId = 'wf-1', taskId = 'task-1'): void {
    adapter.saveTask(
      workflowId,
      createTaskState(taskId, `Task ${taskId}`, [], { workflowId }),
    );
  }

  it('rolls back the mutation when journal append fails', () => {
    saveWorkflow();
    saveTask();
    const beforeSeq = latestSeq();
    const db = (adapter as unknown as {
      db: { run: (sql: string, params?: unknown[]) => void };
    }).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('simulated journal failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => adapter.updateTask('task-1', { status: 'running' })).toThrow(
        'simulated journal failure',
      );
    } finally {
      db.run = originalRun;
    }

    expect(adapter.loadTask('task-1')!.status).toBe('pending');
    expect(latestSeq()).toBe(beforeSeq);
  });

  it('allocates strictly monotonic journal sequences', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    expect(first.seq).toBeGreaterThan(0);
    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
  });

  it('reads journal rows strictly after the supplied cursor', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });
    setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-28T00:00:01.000Z',
    });

    const cursor = getSyncCursor(executor(), 'peer-a')!;
    const entries = readJournalSince(executor(), cursor.lastSentSeq, 10);

    expect(cursor).toMatchObject({
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 7,
    });
    expect(entries.map((entry) => entry.seq)).toEqual([third.seq]);
    expect(readJournalSince(executor(), first.seq, 1).map((entry) => entry.seq)).toEqual([
      second.seq,
    ]);
  });

  it('hides soft-deleted workflows by default and exposes them with includeDeleted', () => {
    saveWorkflow('wf-delete');
    saveWorkflow('wf-live');

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-live']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter
      .listWorkflows({ includeDeleted: true })
      .find((workflow) => workflow.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(
      deleted?.deletedAt,
    );
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    saveWorkflow('wf-delete');
    saveTask('wf-delete', 'task-delete');
    const beforeDeleteSeq = latestSeq();

    adapter.deleteWorkflow('wf-delete');

    const entries = readJournalSince(executor(), beforeDeleteSeq, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entries[0].payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: expect.any(Number),
    });
  });

  it('journals attempt creation and completion snapshots', () => {
    saveWorkflow();
    saveTask();
    const attempt = createAttempt('task-1', { status: 'running' });
    const beforeAttemptSeq = latestSeq();

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-28T00:00:02.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(executor(), beforeAttemptSeq, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(entries[1].payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      completed_at: '2026-07-28T00:00:02.000Z',
    });
  });
});

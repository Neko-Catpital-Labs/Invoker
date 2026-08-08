import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { WorkflowSaveInput } from '../adapter.js';
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
    return (adapter as any).executor as SqliteExecutor;
  }

  function makeWorkflow(id = 'wf-1', name = 'Workflow'): WorkflowSaveInput {
    return {
      id,
      name,
      createdAt: `2026-07-28T00:00:00.000Z`,
      updatedAt: `2026-07-28T00:00:00.000Z`,
    };
  }

  function makeTask(id = 'task-1', status: TaskState['status'] = 'pending'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status,
      dependencies: [],
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back a journal append with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());

    expect(() =>
      adapter.runInTransaction(() => {
        adapter.updateTask('task-1', { status: 'running' });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadTask('task-1')?.status).toBe('pending');
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('fails loudly and rolls back the mutation when the journal write fails', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());

    const db = (adapter as any).db;
    const originalRun = db.run.bind(db) as (sql: string, params?: unknown[]) => unknown;
    db.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('simulated journal failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => adapter.updateTask('task-1', { status: 'running' })).toThrow(/simulated journal failure/);
    } finally {
      db.run = originalRun;
    }

    expect(adapter.loadTask('task-1')?.status).toBe('pending');
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic journal seq values', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
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

  it('reads journal rows after the cursor and stores per-peer cursor pairs', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-2',
      op: 'upsert',
      payload: { id: 'task-2' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-3',
      op: 'upsert',
      payload: { id: 'task-3' },
    });

    expect(readJournalSince(executor(), first.seq, 10).map((entry) => entry.seq)).toEqual([
      second.seq,
      third.seq,
    ]);
    expect(readJournalSince(executor(), 0, 2).map((entry) => entry.seq)).toEqual([
      first.seq,
      second.seq,
    ]);

    const cursor = setSyncCursor(executor(), {
      peerId: 'remote-1',
      lastSentSeq: second.seq,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-28T00:00:01.000Z',
    });

    expect(getSyncCursor(executor(), 'remote-1')).toEqual(cursor);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      third.seq,
    ]);
  });

  it('hides soft-deleted workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete', 'Deleted'));
    adapter.saveWorkflow(makeWorkflow('wf-keep', 'Keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted?.id).toBe('wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((workflow) => workflow.id)).toContain('wf-delete');
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete', 'Deleted'));

    adapter.deleteWorkflow('wf-delete');

    const entries = readJournalSince(executor(), 0, 10);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entries[0]?.payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: expect.any(Number),
    });
  });

  it('journals attempt creation and completion snapshots', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    const attempt = createAttempt('task-1', { status: 'running' });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-28T00:00:02.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(executor(), 0, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(entries[1]?.payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      exit_code: 0,
    });
  });
});

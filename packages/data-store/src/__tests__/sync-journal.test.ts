import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskState, createAttempt } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
  type SyncJournalEntry,
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

  function workflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
  }

  function taskRows(entries: SyncJournalEntry[]): SyncJournalEntry[] {
    return entries.filter((entry) => entry.entityType === 'task');
  }

  it('rolls back journal rows with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(workflow('wf-rollback'));
    adapter.saveTask(
      'wf-rollback',
      createTaskState('task-rollback', 'Task rollback', [], { workflowId: 'wf-rollback' }),
    );
    const beforeSeq = Math.max(0, ...readJournalSince(executor(), 0, 100).map((entry) => entry.seq));

    expect(() => {
      adapter.runInTransaction(() => {
        adapter.updateTask('task-rollback', { status: 'running' });
        throw new Error('force rollback');
      });
    }).toThrow('force rollback');

    expect(adapter.loadTask('task-rollback')?.status).toBe('pending');
    expect(taskRows(readJournalSince(executor(), beforeSeq, 100))).toEqual([]);
  });

  it('allocates strictly monotonic seq values', () => {
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

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
    expect(readJournalSince(executor(), 0, 10).map((entry) => entry.seq)).toEqual([
      first.seq,
      second.seq,
      third.seq,
    ]);
  });

  it('reads journal rows after a peer cursor', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-cursor-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-cursor-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'event',
      entityId: 'event-cursor-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    const cursor = setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 42,
      updatedAt: 12345,
    });

    expect(cursor).toEqual({
      peerId: 'peer-a',
      lastSentSeq: second.seq,
      lastReceivedSeq: 42,
      updatedAt: 12345,
    });
    expect(getSyncCursor(executor(), 'peer-a')).toEqual(cursor);
    expect(readJournalSince(executor(), first.seq, 1).map((entry) => entry.seq)).toEqual([second.seq]);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([third.seq]);
  });

  it('excludes soft-deleted workflows by default but includes them explicitly', () => {
    adapter.saveWorkflow(workflow('wf-soft-delete'));
    adapter.saveTask(
      'wf-soft-delete',
      createTaskState('task-soft-delete', 'Task soft delete', [], { workflowId: 'wf-soft-delete' }),
    );
    const attempt = createAttempt('task-soft-delete', { status: 'running' });
    adapter.saveAttempt(attempt);
    const beforeSeq = Math.max(0, ...readJournalSince(executor(), 0, 100).map((entry) => entry.seq));

    adapter.deleteWorkflow('wf-soft-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-soft-delete')).toBeUndefined();
    const [deleted] = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toMatchObject({
      id: 'wf-soft-delete',
      name: 'Workflow wf-soft-delete',
    });
    expect(typeof deleted?.deletedAt).toBe('number');
    expect(adapter.loadWorkflow('wf-soft-delete', { includeDeleted: true })?.deletedAt).toBe(deleted?.deletedAt);
    expect(adapter.loadTasks('wf-soft-delete')).toEqual([]);
    expect(adapter.loadAttempts('task-soft-delete')).toEqual([]);

    const tombstones = readJournalSince(executor(), beforeSeq, 100).filter(
      (entry) => entry.entityType === 'workflow' && entry.op === 'tombstone',
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entityId: 'wf-soft-delete',
      origin: 'home',
    });
    expect(tombstones[0].payload).toMatchObject({
      id: 'wf-soft-delete',
      deleted_at: deleted?.deletedAt,
    });
  });
});

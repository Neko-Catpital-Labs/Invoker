import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

const NOW = '2026-07-26T12:00:00.000Z';

function executor(adapter: SQLiteAdapter): SqliteExecutor {
  return (adapter as unknown as { executor: SqliteExecutor }).executor;
}

function journalRows(adapter: SQLiteAdapter, seq = 0, limit = 100) {
  return readJournalSince(executor(adapter), seq, limit);
}

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'Sync Workflow',
      createdAt: NOW,
      updatedAt: NOW,
    });
    adapter.saveTask('wf-1', createTaskState('task-1', 'Task 1', [], { workflowId: 'wf-1' }));
  });

  afterEach(() => {
    adapter.close();
  });

  it('rolls back the journal entry with the task mutation', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.updateTask('task-1', { status: 'running' });
        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect(adapter.loadTask('task-1')?.status).toBe('pending');
    expect(journalRows(adapter)).toEqual([]);
  });

  it('assigns strictly monotonic seq values across journaled mutations', () => {
    adapter.updateTask('task-1', { status: 'running' });

    const attempt = createAttempt('task-1', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T12:01:00.000Z'),
      exitCode: 0,
    });

    const rows = journalRows(adapter);
    expect(rows.map((row) => row.entityType)).toEqual(['task', 'attempt', 'attempt']);
    expect(rows.map((row) => row.seq)).toEqual([1, 2, 3]);
    expect(rows[0].seq).toBeLessThan(rows[1].seq);
    expect(rows[1].seq).toBeLessThan(rows[2].seq);
  });

  it('reads journal rows after the stored cursor and respects limit', () => {
    const firstSeq = appendJournalEntry(executor(adapter), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1', status: 'running' },
      createdAt: NOW,
    });
    const secondSeq = appendJournalEntry(executor(adapter), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1, task_id: 'task-1', event_type: 'started' },
      createdAt: NOW,
    });
    const thirdSeq = appendJournalEntry(executor(adapter), {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1', name: 'Sync Workflow' },
      createdAt: NOW,
    });

    setSyncCursor(executor(adapter), {
      peerId: 'remote-a',
      lastSentSeq: firstSeq,
      lastReceivedSeq: 7,
      updatedAt: NOW,
    });

    expect(getSyncCursor(executor(adapter), 'remote-a')).toEqual({
      peerId: 'remote-a',
      lastSentSeq: firstSeq,
      lastReceivedSeq: 7,
      updatedAt: NOW,
    });
    expect(readJournalSince(executor(adapter), firstSeq, 1).map((row) => row.seq)).toEqual([secondSeq]);
    expect(readJournalSince(executor(adapter), firstSeq, 10).map((row) => row.seq)).toEqual([
      secondSeq,
      thirdSeq,
    ]);
  });

  it('excludes soft-deleted workflows from default listings and includes them explicitly', () => {
    adapter.deleteWorkflow('wf-1');

    expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
    expect(adapter.listWorkflows()).toEqual([]);

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      id: 'wf-1',
      name: 'Sync Workflow',
    });
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
  });

  it('writes a workflow tombstone journal entry on soft delete', () => {
    adapter.deleteWorkflow('wf-1');

    const [entry] = journalRows(adapter).filter((row) => row.entityType === 'workflow');
    expect(entry).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entry.payload).toMatchObject({
      id: 'wf-1',
      deleted_at: expect.any(Number),
    });
  });
});

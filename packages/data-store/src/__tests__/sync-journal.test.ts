import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
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

  function executor() {
    return (adapter as any).executor;
  }

  function makeWorkflow(id = 'wf-1'): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  it('rolls back journal rows with the enclosing mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(makeWorkflow('wf-rollback'));
        throw new Error('rollback mutation');
      });
    }).toThrow('rollback mutation');

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(executor(), 0, 100)).toEqual([]);
  });

  it('assigns strictly monotonic seq values for adapter-journaled mutations', () => {
    adapter.saveWorkflow(makeWorkflow('wf-mono'));
    adapter.saveTask('wf-mono', createTaskState('task-mono', 'Task mono', [], { workflowId: 'wf-mono' }));
    adapter.updateTask('task-mono', { status: 'running' });
    const attempt = createAttempt('task-mono', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
      exitCode: 0,
    });

    const seqs = readJournalSince(executor(), 0, 100).map((entry) => entry.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('reads journal entries after a cursor and persists peer cursors', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-cursor-1',
      op: 'upsert',
      payload: { id: 'wf-cursor-1' },
      createdAt: 1000,
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-cursor-2',
      op: 'upsert',
      payload: { id: 'task-cursor-2' },
      createdAt: 1001,
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'attempt',
      entityId: 'attempt-cursor-3',
      op: 'upsert',
      payload: { id: 'attempt-cursor-3' },
      createdAt: 1002,
    });

    const cursor = setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 17,
      updatedAt: 2000,
    });

    expect(cursor).toEqual({
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 17,
      updatedAt: 2000,
    });
    expect(getSyncCursor(executor(), 'peer-a')).toEqual(cursor);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      second.seq,
      third.seq,
    ]);
  });

  it('excludes soft-deleted workflows by default but includes them on request', () => {
    adapter.saveWorkflow(makeWorkflow('wf-soft-delete'));

    adapter.deleteWorkflow('wf-soft-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-soft-delete')).toBeUndefined();
    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      id: 'wf-soft-delete',
      name: 'Workflow wf-soft-delete',
    });
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-soft-delete', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-tombstone'));
    adapter.saveTask('wf-tombstone', createTaskState('task-tombstone', 'Task tombstone', [], { workflowId: 'wf-tombstone' }));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = readJournalSince(executor(), 0, 100)
      .find((entry) => entry.entityType === 'workflow' && entry.entityId === 'wf-tombstone' && entry.op === 'tombstone');
    expect(tombstone).toBeDefined();
    expect(tombstone!.origin).toBe('home');
    expect(tombstone!.payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

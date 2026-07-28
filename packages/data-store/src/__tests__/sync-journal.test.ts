import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';

describe('sync journal persistence foundation', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function workflow(id = 'wf-1'): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    };
  }

  function task(id = 't1'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal rows with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(workflow());
    adapter.saveTask('wf-1', task());

    expect(() =>
      adapter.runInTransaction(() => {
        adapter.updateTask('t1', { status: 'running' });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadTask('t1')?.status).toBe('pending');
    expect(adapter.readJournalSince(0, 100)).toEqual([]);
  });

  it('assigns strictly monotonic sequence numbers', () => {
    adapter.saveWorkflow(workflow());
    adapter.saveTask('wf-1', task());

    adapter.updateTask('t1', { status: 'running' });
    const attempt = createAttempt('t1');
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-28T00:01:00.000Z'),
    });

    const seqs = adapter.readJournalSince(0, 100).map((entry) => entry.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('reads journal entries after the supplied cursor and stores peer cursors', () => {
    const first = adapter.appendJournalEntry({
      entityType: 'task',
      entityId: 't1',
      op: 'upsert',
      payload: { id: 't1', status: 'pending' },
    });
    const second = adapter.appendJournalEntry({
      entityType: 'task',
      entityId: 't1',
      op: 'upsert',
      payload: { id: 't1', status: 'running' },
    });
    const third = adapter.appendJournalEntry({
      entityType: 'attempt',
      entityId: 'a1',
      op: 'upsert',
      payload: { id: 'a1', status: 'pending' },
    });

    const cursor = adapter.setSyncCursor({
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 12,
      updatedAt: '2026-07-28T00:02:00.000Z',
    });

    expect(adapter.getSyncCursor('peer-a')).toEqual(cursor);
    expect(adapter.readJournalSince(cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      second.seq,
      third.seq,
    ]);
    expect(adapter.readJournalSince(first.seq, 1).map((entry) => entry.seq)).toEqual([second.seq]);
  });

  it('hides soft-deleted workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow(workflow('wf-delete'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    expect(adapter.listWorkflows()).toEqual([]);

    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted).toMatchObject({ id: 'wf-delete' });
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((row) => row.id)).toEqual(['wf-delete']);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstones = adapter.readJournalSince(0, 100).filter((entry) =>
      entry.entityType === 'workflow' && entry.entityId === 'wf-tombstone' && entry.op === 'tombstone',
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      origin: 'home',
      payload: {
        id: 'wf-tombstone',
        deleted_at: expect.any(Number),
      },
    });
  });
});

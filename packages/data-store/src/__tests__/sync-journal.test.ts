import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
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

  function db(): any {
    return adapter as any;
  }

  function saveWorkflow(id: string): void {
    adapter.saveWorkflow({
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-28T00:00:00.000Z',
      updatedAt: '2026-07-28T00:00:00.000Z',
    });
  }

  it('rolls journal appends back with the mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        saveWorkflow('wf-rollback');
        appendJournalEntry(db(), {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: { id: 'wf-rollback' },
        });
        throw new Error('force rollback');
      });
    }).toThrow('force rollback');

    expect(adapter.loadWorkflow('wf-rollback')).toBeUndefined();
    expect(readJournalSince(db(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic seq values', () => {
    const first = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
  });

  it('reads entries after a cursor and respects limit', () => {
    const first = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    const second = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    const third = appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    expect(readJournalSince(db(), first.seq, 1).map((entry) => entry.seq)).toEqual([second.seq]);
    expect(readJournalSince(db(), first.seq, 10).map((entry) => entry.seq)).toEqual([
      second.seq,
      third.seq,
    ]);
  });

  it('stores and replaces peer cursor pairs', () => {
    expect(getSyncCursor(db(), 'peer-a')).toBeUndefined();

    expect(setSyncCursor(db(), {
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 34,
      updatedAt: 1000,
    })).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 34,
      updatedAt: 1000,
    });

    expect(setSyncCursor(db(), {
      peerId: 'peer-a',
      lastSentSeq: 56,
      lastReceivedSeq: 78,
      updatedAt: 2000,
    })).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 56,
      lastReceivedSeq: 78,
      updatedAt: 2000,
    });
  });

  it('journals task status changes and attempt creation/completion', () => {
    saveWorkflow('wf-1');
    const task = createTaskState('task-1', 'Task 1', [], { workflowId: 'wf-1' });
    adapter.saveTask('wf-1', task);

    adapter.updateTask('task-1', { status: 'running' });
    const attempt = createAttempt('task-1', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-28T00:01:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(db(), 0, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['task', 'task-1', 'upsert'],
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect((entries[0].payload as { status?: string }).status).toBe('running');
    expect((entries[2].payload as { status?: string }).status).toBe('completed');
  });

  it('excludes soft-deleted workflows by default but includes them when requested', () => {
    saveWorkflow('wf-delete');
    saveWorkflow('wf-keep');

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    expect(withDeleted.map((workflow) => workflow.id).sort()).toEqual(['wf-delete', 'wf-keep']);
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(
      expect.any(Number),
    );
  });

  it('writes a tombstone journal entry when a workflow is soft-deleted', () => {
    saveWorkflow('wf-delete');
    adapter.saveTask('wf-delete', createTaskState('task-1', 'Task 1', [], { workflowId: 'wf-delete' }));

    adapter.deleteWorkflow('wf-delete');

    const entries = readJournalSince(db(), 0, 10);
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
});

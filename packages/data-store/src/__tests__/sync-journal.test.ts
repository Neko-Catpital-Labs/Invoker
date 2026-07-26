import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';
import type { Workflow } from '../adapter.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  const testWorkflow: Workflow = {
    id: 'wf-sync',
    name: 'Sync Workflow',
    status: 'pending',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
  };

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function journalDb(): Parameters<typeof appendJournalEntry>[0] {
    return (adapter as any).executor;
  }

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  it('rolls back journal rows with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-rollback'));
    const cursor = readJournalSince(journalDb(), 0, 100).at(-1)?.seq ?? 0;

    expect(() => {
      adapter.runInTransaction(() => {
        adapter.updateTask('task-rollback', { status: 'running' });
        throw new Error('rollback sentinel');
      });
    }).toThrow(/rollback sentinel/);

    expect(adapter.loadTask('task-rollback')?.status).toBe('pending');
    expect(readJournalSince(journalDb(), cursor, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values', () => {
    const first = appendJournalEntry(journalDb(), {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a', status: 'pending' },
    });
    const second = appendJournalEntry(journalDb(), {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a', status: 'running' },
    });
    const third = appendJournalEntry(journalDb(), {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a', status: 'completed' },
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(readJournalSince(journalDb(), 0, 10).map((entry) => entry.seq)).toEqual([
      first,
      second,
      third,
    ]);
  });

  it('reads journal entries after the stored peer cursor', () => {
    const first = appendJournalEntry(journalDb(), {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(journalDb(), {
      entityType: 'workflow',
      entityId: 'wf-b',
      op: 'upsert',
      payload: { id: 'wf-b' },
    });
    appendJournalEntry(journalDb(), {
      entityType: 'workflow',
      entityId: 'wf-c',
      op: 'upsert',
      payload: { id: 'wf-c' },
    });

    const cursor = setSyncCursor(journalDb(), {
      peerId: 'peer-1',
      lastSentSeq: first,
      lastReceivedSeq: 42,
      updatedAt: '2026-07-26T00:00:01.000Z',
    });

    expect(getSyncCursor(journalDb(), 'peer-1')).toEqual(cursor);
    expect(readJournalSince(journalDb(), cursor.lastSentSeq, 1).map((entry) => entry.seq)).toEqual([
      second,
    ]);
  });

  it('soft-deletes workflows by default and journals a tombstone', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-delete'));
    const cursor = readJournalSince(journalDb(), 0, 100).at(-1)?.seq ?? 0;

    adapter.deleteWorkflow(testWorkflow.id);

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow(testWorkflow.id)).toBeUndefined();

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ id: testWorkflow.id });
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow(testWorkflow.id, { includeDeleted: true })?.deletedAt)
      .toBe(deleted[0].deletedAt);

    const [tombstone] = readJournalSince(journalDb(), cursor, 10);
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: testWorkflow.id,
      op: 'tombstone',
      origin: 'home',
    });
    expect((tombstone.payload as { deleted_at?: number }).deleted_at).toBe(deleted[0].deletedAt);
  });
});

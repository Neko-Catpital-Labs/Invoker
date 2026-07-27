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
    adapter.saveWorkflow({
      id: 'wf-sync',
      name: 'Sync workflow',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    });
    adapter.saveTask('wf-sync', createTaskState('task-sync', 'Sync task', [], { workflowId: 'wf-sync' }));
  });

  afterEach(() => {
    adapter.close();
  });

  function exec(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  it('rolls back appended journal rows with the enclosing mutation transaction', () => {
    expect(() => exec().runTransaction(() => {
      exec().execRun("UPDATE tasks SET status = 'running' WHERE id = ?", ['task-sync']);
      const payload = exec().queryOne('SELECT * FROM tasks WHERE id = ?', ['task-sync']);
      appendJournalEntry(exec(), {
        entityType: 'task',
        entityId: 'task-sync',
        op: 'upsert',
        payload,
      });
      throw new Error('rollback sync mutation');
    })).toThrow('rollback sync mutation');

    expect(adapter.loadTask('task-sync')?.status).toBe('pending');
    expect(readJournalSince(exec(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic seq values for adapter mutation hooks', () => {
    adapter.updateTask('task-sync', { status: 'running' });
    const attempt = createAttempt('task-sync', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
      exitCode: 0,
    });

    const entries = adapter.readJournalSince(0, 20);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index].seq).toBeGreaterThan(entries[index - 1].seq);
    }
  });

  it('reads journal entries strictly after the supplied cursor and persists peer cursors', () => {
    adapter.updateTask('task-sync', { status: 'running' });
    const attempt = createAttempt('task-sync', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'failed',
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
      error: 'failed',
    });

    const entries = adapter.readJournalSince(0, 20);
    const cursor = setSyncCursor(exec(), {
      peerId: 'peer-a',
      lastSentSeq: entries[1].seq,
      lastReceivedSeq: 4,
      updatedAt: 12345,
    });

    expect(getSyncCursor(exec(), 'peer-a')).toEqual(cursor);
    expect(adapter.readJournalSince(cursor.lastSentSeq, 20).map((entry) => entry.seq))
      .toEqual(entries.slice(2).map((entry) => entry.seq));
  });

  it('excludes soft-deleted workflows by default and includes them when requested', () => {
    adapter.deleteWorkflow('wf-sync');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-sync')).toBeUndefined();
    expect(adapter.loadTasks('wf-sync')).toEqual([]);

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({ id: 'wf-sync', name: 'Sync workflow' });
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-sync', { includeDeleted: true })?.deletedAt)
      .toBe(deleted[0].deletedAt);
  });

  it('writes a workflow tombstone journal entry on workflow delete', () => {
    adapter.deleteWorkflow('wf-sync');

    const [tombstone] = adapter.readJournalSince(0, 20)
      .filter((entry) => entry.entityType === 'workflow' && entry.op === 'tombstone');
    expect(tombstone).toBeDefined();
    expect(tombstone.entityId).toBe('wf-sync');
    expect(tombstone.origin).toBe('home');
    expect(tombstone.payload).toMatchObject({
      id: 'wf-sync',
      deleted_at: expect.any(Number),
    });
  });
});

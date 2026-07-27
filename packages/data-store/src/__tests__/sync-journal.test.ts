import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
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

  function exec(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function makeWorkflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  function makeTask(id: string): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  function journal(): SyncJournalEntry[] {
    return readJournalSince(exec(), 0, 100);
  }

  it('rolls back a journal append with the status mutation', () => {
    adapter.saveWorkflow(makeWorkflow('wf-rollback'));
    adapter.saveTask('wf-rollback', makeTask('task-rollback'));
    const beforeJournal = journal();

    expect(() => adapter.runInTransaction(() => {
      adapter.updateTask('task-rollback', { status: 'running' });
      throw new Error('force rollback');
    })).toThrow('force rollback');

    expect(adapter.loadTask('task-rollback')?.status).toBe('pending');
    expect(journal()).toEqual(beforeJournal);
  });

  it('assigns strictly monotonic seq values', () => {
    adapter.saveWorkflow(makeWorkflow('wf-seq'));
    adapter.saveTask('wf-seq', makeTask('task-seq'));
    adapter.updateTask('task-seq', { status: 'running' });
    const attempt = createAttempt('task-seq', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
      exitCode: 0,
    });

    const seqs = journal().map((entry) => entry.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('reads journal entries after the stored peer cursor', () => {
    adapter.saveWorkflow(makeWorkflow('wf-cursor'));
    adapter.saveTask('wf-cursor', makeTask('task-cursor'));
    adapter.updateTask('task-cursor', { status: 'running' });
    const all = journal();
    const cursorSeq = all[1].seq;

    setSyncCursor(exec(), {
      peerId: 'remote-a',
      lastSentSeq: cursorSeq,
      lastReceivedSeq: 12,
      updatedAt: '2026-07-27T00:02:00.000Z',
    });

    const cursor = getSyncCursor(exec(), 'remote-a')!;
    expect(cursor).toMatchObject({
      peerId: 'remote-a',
      lastSentSeq: cursorSeq,
      lastReceivedSeq: 12,
      updatedAt: '2026-07-27T00:02:00.000Z',
    });
    expect(readJournalSince(exec(), cursor.lastSentSeq, 10)).toEqual(all.slice(2));
  });

  it('excludes soft-deleted workflows by default and includes them explicitly', () => {
    adapter.saveWorkflow(makeWorkflow('wf-soft-delete'));

    adapter.deleteWorkflow('wf-soft-delete');

    expect(adapter.loadWorkflow('wf-soft-delete')).toBeUndefined();
    expect(adapter.listWorkflows()).toEqual([]);

    const deleted = adapter.loadWorkflow('wf-soft-delete', { includeDeleted: true });
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((workflow) => workflow.id))
      .toEqual(['wf-soft-delete']);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = journal().at(-1)!;
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: 'home',
    });
    expect(tombstone.payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

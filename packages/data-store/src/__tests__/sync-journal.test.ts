import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { Workflow } from '../adapter.js';
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

  function execOf(db: SQLiteAdapter): SqliteExecutor {
    return (db as unknown as { executor: SqliteExecutor }).executor;
  }

  function workflow(id: string): Workflow {
    return {
      id,
      name: id,
      status: 'pending',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  it('rolls back a journal append with the mutation that created it', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        (adapter as any).db.run(
          `INSERT INTO workflows (id, name, created_at, updated_at)
           VALUES ('wf-rollback', 'Rollback', '2026-07-27T00:00:00.000Z', '2026-07-27T00:00:00.000Z')`,
        );
        appendJournalEntry(execOf(adapter), {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: { id: 'wf-rollback' },
        });
        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(execOf(adapter), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic journal sequence numbers', () => {
    adapter.saveWorkflow(workflow('wf-seq'));
    const task = createTaskState('task-seq', 'Task seq', [], { workflowId: 'wf-seq' });
    adapter.saveTask('wf-seq', task);
    adapter.updateTask('task-seq', { status: 'running' });
    const attempt = createAttempt('task-seq', { status: 'pending' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, { status: 'completed', completedAt: new Date('2026-07-27T00:00:01.000Z') });

    const seqs = readJournalSince(execOf(adapter), 0, 20).map((entry) => entry.seq);
    expect(seqs.length).toBeGreaterThanOrEqual(5);
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('reads journal entries after the stored peer cursor', () => {
    adapter.saveWorkflow(workflow('wf-cursor'));
    adapter.saveTask('wf-cursor', createTaskState('task-cursor', 'Task cursor', [], { workflowId: 'wf-cursor' }));
    adapter.updateTask('task-cursor', { status: 'running' });

    const all = readJournalSince(execOf(adapter), 0, 10);
    const cursor = setSyncCursor(execOf(adapter), {
      peerId: 'peer-a',
      lastSentSeq: all[0].seq,
      lastReceivedSeq: 7,
      updatedAt: 1000,
    });
    expect(getSyncCursor(execOf(adapter), 'peer-a')).toEqual(cursor);

    const unread = readJournalSince(execOf(adapter), cursor.lastSentSeq, 10);
    expect(unread.map((entry) => entry.seq)).toEqual(all.slice(1).map((entry) => entry.seq));
  });

  it('excludes soft-deleted workflows from default listings and reads them with includeDeleted', () => {
    adapter.saveWorkflow(workflow('wf-delete'));
    adapter.saveWorkflow(workflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((entry) => entry.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.listWorkflows({ includeDeleted: true }).find((entry) => entry.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = readJournalSince(execOf(adapter), 0, 20).find(
      (entry) => entry.entityType === 'workflow' && entry.entityId === 'wf-tombstone' && entry.op === 'tombstone',
    );
    expect(tombstone).toBeDefined();
    expect((tombstone!.payload as { id?: string }).id).toBe('wf-tombstone');
    expect((tombstone!.payload as { deleted_at?: number }).deleted_at).toEqual(expect.any(Number));
  });
});

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

  function exec(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
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
        adapter.saveWorkflow(workflow('wf-rollback'));
        throw new Error('rollback sentinel');
      });
    }).toThrow(/rollback sentinel/);

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(exec(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic seq values', () => {
    adapter.saveWorkflow(workflow('wf-seq'));
    adapter.saveTask(
      'wf-seq',
      createTaskState('task-seq', 'Task Seq', [], { workflowId: 'wf-seq' }),
    );
    adapter.updateTask('task-seq', { status: 'running' });
    adapter.saveAttempt(createAttempt('task-seq', { status: 'running' }));

    const entries = readJournalSince(exec(), 0, 20);
    expect(entries.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
    }
  });

  it('reads journal entries after the provided cursor', () => {
    appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });
    appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
    });
    appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'event-3',
      op: 'upsert',
      payload: { id: 3 },
    });

    const [first] = readJournalSince(exec(), 0, 1);
    setSyncCursor(exec(), {
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-27T00:01:00.000Z',
    });

    const cursor = getSyncCursor(exec(), 'peer-a')!;
    expect(cursor).toMatchObject({
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-27T00:01:00.000Z',
    });
    expect(readJournalSince(exec(), cursor.lastSentSeq, 10).map((entry) => entry.entityId))
      .toEqual(['event-2', 'event-3']);
  });

  it('excludes soft-deleted workflows by default and includes them on request', () => {
    adapter.saveWorkflow(workflow('wf-delete'));
    adapter.saveWorkflow(workflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((wf) => wf.id)).toEqual(['wf-keep']);
    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    const deleted = withDeleted.find((wf) => wf.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt)
      .toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when a workflow is soft-deleted', () => {
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = readJournalSince(exec(), 0, 20)
      .find((entry) => (
        entry.entityType === 'workflow'
        && entry.entityId === 'wf-tombstone'
        && entry.op === 'tombstone'
      ));
    expect(tombstone).toBeDefined();
    expect(tombstone!.origin).toBe('home');
    expect(tombstone!.payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

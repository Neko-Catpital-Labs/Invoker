import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { WorkflowSaveInput } from '../adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

type JournalDb =
  Parameters<typeof appendJournalEntry>[0] &
  Parameters<typeof readJournalSince>[0] &
  Parameters<typeof getSyncCursor>[0] &
  Parameters<typeof setSyncCursor>[0];

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function db(): JournalDb {
    return adapter as unknown as JournalDb;
  }

  function workflow(
    id: string,
    name = id,
    createdAt = '2026-07-01T00:00:00.000Z',
  ): WorkflowSaveInput {
    return {
      id,
      name,
      createdAt,
      updatedAt: createdAt,
    };
  }

  function saveWorkflowAndTask(workflowId = 'wf-1', taskId = 'task-1'): void {
    adapter.saveWorkflow(workflow(workflowId));
    adapter.saveTask(
      workflowId,
      createTaskState(taskId, `Task ${taskId}`, [], { workflowId }),
    );
  }

  it('rolls back journal rows with the mutation transaction', () => {
    saveWorkflowAndTask();

    expect(() =>
      adapter.runInTransaction(() => {
        adapter.updateTask('task-1', { status: 'running' });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadTask('task-1')?.status).toBe('pending');
    expect(readJournalSince(db(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic journal seq values', () => {
    appendJournalEntry(db(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1', status: 'running' },
    });
    appendJournalEntry(db(), {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1', status: 'completed' },
    });
    appendJournalEntry(db(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1, event_type: 'task.completed' },
    });

    const rows = readJournalSince(db(), 0, 10);
    expect(rows).toHaveLength(3);
    expect(rows[1].seq).toBeGreaterThan(rows[0].seq);
    expect(rows[2].seq).toBeGreaterThan(rows[1].seq);
  });

  it('reads journal rows after the supplied cursor', () => {
    for (const id of ['one', 'two', 'three']) {
      appendJournalEntry(db(), {
        entityType: 'task',
        entityId: id,
        op: 'upsert',
        payload: { id },
      });
    }

    const allRows = readJournalSince(db(), 0, 10);
    const afterSecond = readJournalSince(db(), allRows[1].seq, 10);

    expect(afterSecond.map((row) => row.entityId)).toEqual(['three']);
  });

  it('sets and gets remote peer cursors', () => {
    setSyncCursor(db(), {
      peerId: 'remote-laptop',
      lastSentSeq: 12,
      lastReceivedSeq: 8,
      updatedAt: '2026-07-01T00:00:01.000Z',
    });

    expect(getSyncCursor(db(), 'remote-laptop')).toEqual({
      peerId: 'remote-laptop',
      lastSentSeq: 12,
      lastReceivedSeq: 8,
      updatedAt: '2026-07-01T00:00:01.000Z',
    });
  });

  it('excludes soft-deleted workflows by default but can include them', () => {
    adapter.saveWorkflow(workflow('deleted-wf', 'Deleted'));
    adapter.saveWorkflow(workflow('live-wf', 'Live', '2026-07-01T00:01:00.000Z'));

    adapter.deleteWorkflow('deleted-wf');

    expect(adapter.listWorkflows().map((wf) => wf.id)).toEqual(['live-wf']);
    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    expect(withDeleted.map((wf) => wf.id)).toEqual(['live-wf', 'deleted-wf']);
    expect(withDeleted.find((wf) => wf.id === 'deleted-wf')?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when a workflow is deleted', () => {
    adapter.saveWorkflow(workflow('wf-delete'));

    adapter.deleteWorkflow('wf-delete');

    const [entry] = readJournalSince(db(), 0, 10);
    expect(entry).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect(entry.payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: expect.any(Number),
    });
  });
});

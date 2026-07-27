import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { WorkflowSaveInput } from '../adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  LOCAL_SYNC_ORIGIN,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

type JournalDb = Parameters<typeof appendJournalEntry>[0];

function executor(adapter: SQLiteAdapter): JournalDb {
  return (adapter as unknown as { executor: JournalDb }).executor;
}

function makeWorkflow(id: string): WorkflowSaveInput {
  return {
    id,
    name: `Workflow ${id}`,
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };
}

function expectStrictlyIncreasing(values: number[]): void {
  for (let i = 1; i < values.length; i += 1) {
    expect(values[i]).toBeGreaterThan(values[i - 1]!);
  }
}

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('rolls back journal appends with the mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(makeWorkflow('wf-rollback'));
        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(executor(adapter), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values to adapter journal writes', () => {
    adapter.saveWorkflow(makeWorkflow('wf-seq'));
    const task = createTaskState('task-seq', 'Task seq', [], { workflowId: 'wf-seq' });
    adapter.saveTask('wf-seq', task);
    adapter.updateTask('task-seq', { status: 'running' });

    const attempt = createAttempt('task-seq', {
      status: 'running',
    });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:02:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(executor(adapter), 0, 20);
    expect(entries.map((entry) => entry.entityType)).toEqual([
      'workflow',
      'task',
      'task',
      'attempt',
      'attempt',
    ]);
    expectStrictlyIncreasing(entries.map((entry) => entry.seq));
  });

  it('reads journal entries after the stored peer cursor', () => {
    const db = executor(adapter);
    const firstSeq = appendJournalEntry(db, {
      entityType: 'workflow',
      entityId: 'wf-cursor-1',
      op: 'upsert',
      payload: { id: 'wf-cursor-1' },
    });
    const secondSeq = appendJournalEntry(db, {
      entityType: 'task',
      entityId: 'task-cursor-2',
      op: 'upsert',
      payload: { id: 'task-cursor-2' },
    });
    const thirdSeq = appendJournalEntry(db, {
      entityType: 'attempt',
      entityId: 'attempt-cursor-3',
      op: 'upsert',
      payload: { id: 'attempt-cursor-3' },
    });

    expectStrictlyIncreasing([firstSeq, secondSeq, thirdSeq]);
    setSyncCursor(db, {
      peerId: 'remote-a',
      lastSentSeq: secondSeq,
      lastReceivedSeq: 7,
      updatedAt: 1234,
    });

    const cursor = getSyncCursor(db, 'remote-a')!;
    expect(cursor).toEqual({
      peerId: 'remote-a',
      lastSentSeq: secondSeq,
      lastReceivedSeq: 7,
      updatedAt: 1234,
    });
    expect(readJournalSince(db, cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([thirdSeq]);
  });

  it('excludes soft-deleted workflows from default reads and includes them explicitly', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();
    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted?.id).toBe('wf-delete');
    expect(typeof deleted?.deletedAt).toBe('number');
    expect(adapter.listWorkflows({ includeDeleted: true }).map((workflow) => workflow.id)).toEqual(['wf-delete']);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const entries = readJournalSince(executor(adapter), 0, 10);
    const tombstone = entries.at(-1)!;
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: LOCAL_SYNC_ORIGIN,
    });
    expect((tombstone.payload as { id?: string; deleted_at?: number }).id).toBe('wf-tombstone');
    expect(typeof (tombstone.payload as { deleted_at?: number }).deleted_at).toBe('number');
  });
});

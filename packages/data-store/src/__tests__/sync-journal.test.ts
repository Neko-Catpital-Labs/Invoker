import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';
import type { Workflow } from '../adapter.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;
  let exec: SqliteExecutor;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    exec = (adapter as unknown as { executor: SqliteExecutor }).executor;
  });

  afterEach(() => {
    adapter.close();
  });

  function makeWorkflow(id: string, overrides: Partial<Workflow> = {}): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
      ...overrides,
    };
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

  it('rolls back journal entries with the enclosing mutation transaction', () => {
    expect(() => exec.runTransaction(() => {
      adapter.saveWorkflow(makeWorkflow('wf-rollback'));
      throw new Error('rollback marker');
    })).toThrow('rollback marker');

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(exec, 0, 10)).toEqual([]);
  });

  it('keeps seq strictly monotonic across appended and hooked entries', () => {
    const first = appendJournalEntry(exec, {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
    });

    adapter.saveWorkflow(makeWorkflow('wf-monotonic'));
    adapter.saveTask('wf-monotonic', makeTask('task-monotonic'));
    adapter.updateTask('task-monotonic', { status: 'running' });

    const attempt = createAttempt('task-monotonic');
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T00:00:01.000Z'),
    });

    const entries = readJournalSince(exec, 0, 20);
    expect(entries[0].seq).toBe(first);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
    }
    expect(entries.map((entry) => `${entry.entityType}:${entry.op}`)).toEqual([
      'event:upsert',
      'workflow:upsert',
      'task:upsert',
      'workflow:upsert',
      'attempt:upsert',
      'attempt:upsert',
    ]);
  });

  it('reads journal entries after the stored peer cursor', () => {
    const seq1 = appendJournalEntry(exec, {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const seq2 = appendJournalEntry(exec, {
      entityType: 'task',
      entityId: 'task-2',
      op: 'upsert',
      payload: { id: 'task-2' },
    });
    const seq3 = appendJournalEntry(exec, {
      entityType: 'task',
      entityId: 'task-3',
      op: 'upsert',
      payload: { id: 'task-3' },
    });

    setSyncCursor(exec, {
      peerId: 'peer-a',
      lastSentSeq: seq2,
      lastReceivedSeq: 41,
      updatedAt: '2026-07-26T00:00:02.000Z',
    });

    const cursor = getSyncCursor(exec, 'peer-a')!;
    expect(cursor).toMatchObject({
      peerId: 'peer-a',
      lastSentSeq: seq2,
      lastReceivedSeq: 41,
    });
    expect(readJournalSince(exec, seq1, 10).map((entry) => entry.seq)).toEqual([seq2, seq3]);
    expect(readJournalSince(exec, cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([seq3]);
  });

  it('soft-deletes workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    adapter.saveWorkflow(makeWorkflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((workflow) => workflow.id).sort()).toEqual([
      'wf-delete',
      'wf-keep',
    ]);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstones = readJournalSince(exec, 0, 10).filter((entry) => entry.op === 'tombstone');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0]).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      origin: 'home',
    });
    expect(tombstones[0].payload).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });

  it('fails the enclosing mutation when the journal append fails', () => {
    adapter.saveWorkflow(makeWorkflow('wf-loud'));
    adapter.saveTask('wf-loud', makeTask('task-loud'));
    exec.run('DROP TABLE sync_journal');

    expect(() => adapter.updateTask('task-loud', { status: 'running' })).toThrow(/sync_journal/);
    expect(adapter.loadTask('task-loud')?.status).toBe('pending');
  });
});

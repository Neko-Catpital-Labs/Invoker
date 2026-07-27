import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
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
  });

  afterEach(() => {
    adapter.close();
  });

  function exec(): SqliteExecutor {
    return (adapter as any).executor as SqliteExecutor;
  }

  function workflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  function task(id: string): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal appends with the enclosing mutation transaction', () => {
    adapter.saveWorkflow(workflow('wf-rollback'));
    adapter.saveTask('wf-rollback', task('task-rollback'));
    const beforeSeqs = readJournalSince(exec(), 0, 100).map((entry) => entry.seq);

    expect(() => {
      adapter.runInTransaction(() => {
        adapter.updateTask('task-rollback', { status: 'running' });
        throw new Error('simulated rollback');
      });
    }).toThrow('simulated rollback');

    expect(adapter.loadTask('task-rollback')?.status).toBe('pending');
    expect(readJournalSince(exec(), 0, 100).map((entry) => entry.seq)).toEqual(beforeSeqs);
  });

  it('allocates strictly monotonic seq values and reads entries after the supplied cursor', () => {
    const firstSeq = appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'event-1',
      op: 'upsert',
      payload: { id: 1 },
      createdAt: 1000,
    });
    const secondSeq = appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'event-2',
      op: 'upsert',
      payload: { id: 2 },
      createdAt: 1001,
    });

    expect(secondSeq).toBeGreaterThan(firstSeq);
    expect(readJournalSince(exec(), firstSeq, 10).map((entry) => entry.seq)).toEqual([secondSeq]);
    expect(readJournalSince(exec(), secondSeq, 10)).toEqual([]);

    expect(getSyncCursor(exec(), 'peer-a')).toBeUndefined();
    setSyncCursor(exec(), {
      peerId: 'peer-a',
      lastSentSeq: firstSeq,
      lastReceivedSeq: secondSeq,
      updatedAt: 2000,
    });
    expect(getSyncCursor(exec(), 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: firstSeq,
      lastReceivedSeq: secondSeq,
      updatedAt: 2000,
    });
  });

  it('journals attempt creation and completion snapshots', () => {
    adapter.saveWorkflow(workflow('wf-attempt'));
    adapter.saveTask('wf-attempt', task('task-attempt'));

    const attempt = createAttempt('task-attempt', { status: 'pending' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-01-01T00:01:00.000Z'),
      exitCode: 0,
    });

    const attemptEntries = readJournalSince(exec(), 0, 100)
      .filter((entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id);
    expect(attemptEntries.map((entry) => entry.op)).toEqual(['upsert', 'upsert']);
    expect((attemptEntries[0]!.payload as { status?: string }).status).toBe('pending');
    expect((attemptEntries[1]!.payload as { status?: string }).status).toBe('completed');
    expect(attemptEntries[1]!.seq).toBeGreaterThan(attemptEntries[0]!.seq);
  });

  it('excludes soft-deleted workflows by default and journals a tombstone on delete', () => {
    adapter.saveWorkflow(workflow('wf-soft-delete'));
    adapter.saveTask('wf-soft-delete', task('task-soft-delete'));

    adapter.deleteWorkflow('wf-soft-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-soft-delete')).toBeUndefined();
    expect(adapter.loadTasks('wf-soft-delete')).toEqual([]);

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]!.id).toBe('wf-soft-delete');
    expect(deleted[0]!.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-soft-delete', { includeDeleted: true })?.deletedAt)
      .toBe(deleted[0]!.deletedAt);

    const tombstone = readJournalSince(exec(), 0, 100)
      .find((entry) =>
        entry.entityType === 'workflow'
        && entry.entityId === 'wf-soft-delete'
        && entry.op === 'tombstone');
    expect(tombstone).toBeDefined();
    expect(tombstone!.origin).toBe('home');
    expect((tombstone!.payload as { id?: string; deleted_at?: number }).id).toBe('wf-soft-delete');
    expect((tombstone!.payload as { deleted_at?: number }).deleted_at).toBe(deleted[0]!.deletedAt);
  });
});

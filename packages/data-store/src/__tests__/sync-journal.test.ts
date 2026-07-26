import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import type { SqliteExecutor } from '../sqlite-executor.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;
  let exec: SqliteExecutor;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    exec = executorFor(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  function saveWorkflow(id = 'wf-1'): void {
    adapter.saveWorkflow({
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    });
  }

  function saveTask(workflowId = 'wf-1', taskId = `${workflowId}/task-1`): void {
    adapter.saveTask(
      workflowId,
      createTaskState(taskId, `Task ${taskId}`, [], { workflowId }),
    );
  }

  it('rolls back the journal append with the enclosing mutation transaction', () => {
    saveWorkflow();
    saveTask();
    const before = readJournalSince(exec, 0, 100).length;

    expect(() =>
      adapter.runInTransaction(() => {
        adapter.updateTask('wf-1/task-1', { status: 'running' });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadTask('wf-1/task-1')?.status).toBe('pending');
    expect(readJournalSince(exec, 0, 100)).toHaveLength(before);
  });

  it('fails the enclosing transaction when the journal append fails', () => {
    saveWorkflow();
    saveTask();
    (adapter as unknown as { db: { run: (sql: string) => void } }).db.run(`
      CREATE TRIGGER fail_sync_journal_insert
      BEFORE INSERT ON sync_journal
      BEGIN
        SELECT RAISE(ABORT, 'journal blocked');
      END
    `);

    expect(() => adapter.updateTask('wf-1/task-1', { status: 'running' })).toThrow(/journal blocked/);
    expect(adapter.loadTask('wf-1/task-1')?.status).toBe('pending');
  });

  it('assigns strictly monotonic journal sequences', () => {
    const first = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(exec, {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a' },
    });
    const third = appendJournalEntry(exec, {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a' },
    });

    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(readJournalSince(exec, 0, 10).map((entry) => entry.seq)).toEqual([first, second, third]);
  });

  it('reads journal rows after the stored peer cursor', () => {
    const first = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(exec, {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a' },
    });
    const third = appendJournalEntry(exec, {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a' },
    });
    setSyncCursor(exec, {
      peerId: 'peer-a',
      lastSentSeq: first,
      lastReceivedSeq: 9,
      updatedAt: 1_785_062_400_000,
    });

    expect(getSyncCursor(exec, 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: first,
      lastReceivedSeq: 9,
      updatedAt: 1_785_062_400_000,
    });
    expect(readJournalSince(exec, getSyncCursor(exec, 'peer-a')!.lastSentSeq, 10).map((entry) => entry.seq))
      .toEqual([second, third]);
    expect(readJournalSince(exec, first, 1).map((entry) => entry.seq)).toEqual([second]);
  });

  it('journals attempt creation and completion snapshots', () => {
    saveWorkflow();
    saveTask();
    const attempt = createAttempt('wf-1/task-1', {
      status: 'running',
      createdAt: new Date('2026-07-26T00:00:01.000Z'),
    });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T00:00:02.000Z'),
      exitCode: 0,
    });

    const attemptEntries = readJournalSince(exec, 0, 100)
      .filter((entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id);
    expect(attemptEntries).toHaveLength(2);
    expect((attemptEntries[0].payload as { status?: string }).status).toBe('running');
    expect((attemptEntries[1].payload as { status?: string; completed_at?: string }).status).toBe('completed');
    expect((attemptEntries[1].payload as { completed_at?: string }).completed_at).toBe('2026-07-26T00:00:02.000Z');
  });

  it('excludes soft-deleted workflows by default and exposes them with includeDeleted', () => {
    saveWorkflow('wf-delete');

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toHaveLength(1);
    expect(deleted[0].id).toBe('wf-delete');
    expect(deleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toBe(deleted[0].deletedAt);

    const tombstones = readJournalSince(exec, 0, 100)
      .filter((entry) => entry.entityType === 'workflow' && entry.entityId === 'wf-delete' && entry.op === 'tombstone');
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].origin).toBe('home');
    expect((tombstones[0].payload as { id?: string; deleted_at?: number }).id).toBe('wf-delete');
    expect((tombstones[0].payload as { deleted_at?: number }).deleted_at).toEqual(expect.any(Number));
  });
});

function executorFor(adapter: SQLiteAdapter): SqliteExecutor {
  const raw = adapter as unknown as {
    queryOne: (sql: string, params?: unknown[]) => Record<string, unknown> | undefined;
    queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[];
    execRun: (sql: string, params?: unknown[]) => void;
    runInTransaction: <T>(work: () => T) => T;
    db: {
      run: (sql: string, params?: unknown[]) => void;
      getRowsModified: () => number;
    };
    readOnly?: boolean;
  };
  return {
    queryOne: raw.queryOne.bind(adapter),
    queryAll: raw.queryAll.bind(adapter),
    execRun: raw.execRun.bind(adapter),
    runTransaction: raw.runInTransaction.bind(adapter),
    run: raw.db.run.bind(raw.db),
    getRowsModified: raw.db.getRowsModified.bind(raw.db),
    readOnly: raw.readOnly === true,
    markDirty: () => {
      // Test helper only; normal adapter journal calls use the adapter's own executor.
    },
  };
}

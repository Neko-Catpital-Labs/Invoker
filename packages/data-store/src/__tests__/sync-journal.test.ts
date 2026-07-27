import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
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

  function executor(): SqliteExecutor {
    const raw = adapter as unknown as {
      queryOne: (sql: string, params?: unknown[]) => Record<string, unknown> | undefined;
      queryAll: (sql: string, params?: unknown[]) => Record<string, unknown>[];
      execRun: (sql: string, params?: unknown[]) => void;
      db: {
        run: (sql: string, params?: unknown[]) => void;
        getRowsModified: () => number;
      };
      dirty: boolean;
    };
    return {
      queryOne: (sql, params) => raw.queryOne.call(adapter, sql, params),
      queryAll: (sql, params) => raw.queryAll.call(adapter, sql, params),
      execRun: (sql, params) => raw.execRun.call(adapter, sql, params),
      runTransaction: (work) => adapter.runInTransaction(work),
      run: (sql, params) => raw.db.run(sql, params),
      getRowsModified: () => raw.db.getRowsModified(),
      readOnly: false,
      markDirty: () => {
        raw.dirty = true;
      },
    };
  }

  function workflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  function task(id: string, workflowId: string): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      config: { workflowId },
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal appends with the mutation transaction', () => {
    const exec = executor();

    expect(() => adapter.runInTransaction(() => {
      exec.run(
        `INSERT INTO workflows (id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
        [
          'wf-rollback',
          'Rollback',
          '2026-07-27T00:00:00.000Z',
          '2026-07-27T00:00:00.000Z',
        ],
      );
      appendJournalEntry(exec, {
        entityType: 'workflow',
        entityId: 'wf-rollback',
        op: 'upsert',
        payload: { id: 'wf-rollback' },
      });
      throw new Error('rollback requested');
    })).toThrow('rollback requested');

    expect(readJournalSince(exec, 0, 10)).toEqual([]);
    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
  });

  it('allocates strictly monotonic seq values', () => {
    const exec = executor();
    const seqs = [
      appendJournalEntry(exec, {
        entityType: 'task',
        entityId: 'task-1',
        op: 'upsert',
        payload: { id: 'task-1', status: 'pending' },
      }),
      appendJournalEntry(exec, {
        entityType: 'task',
        entityId: 'task-2',
        op: 'upsert',
        payload: { id: 'task-2', status: 'running' },
      }),
      appendJournalEntry(exec, {
        entityType: 'attempt',
        entityId: 'attempt-1',
        op: 'upsert',
        payload: { id: 'attempt-1', status: 'completed' },
      }),
    ];

    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
    expect(readJournalSince(exec, 0, 10).map((entry) => entry.seq)).toEqual(seqs);
  });

  it('reads journal pages after the stored peer cursor', () => {
    const exec = executor();
    const first = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
    });
    const second = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-2',
      op: 'upsert',
      payload: { id: 'wf-2' },
    });
    const third = appendJournalEntry(exec, {
      entityType: 'workflow',
      entityId: 'wf-3',
      op: 'upsert',
      payload: { id: 'wf-3' },
    });

    setSyncCursor(exec, {
      peerId: 'remote-a',
      lastSentSeq: first,
      lastReceivedSeq: 42,
      updatedAt: '2026-07-27T00:00:01.000Z',
    });

    const cursor = getSyncCursor(exec, 'remote-a')!;
    expect(cursor).toMatchObject({
      peerId: 'remote-a',
      lastSentSeq: first,
      lastReceivedSeq: 42,
    });
    expect(readJournalSince(exec, cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      second,
      third,
    ]);

    setSyncCursor(exec, {
      peerId: 'remote-a',
      lastSentSeq: third,
      updatedAt: '2026-07-27T00:00:02.000Z',
    });
    expect(getSyncCursor(exec, 'remote-a')?.lastReceivedSeq).toBe(42);
  });

  it('journals task status updates and attempt creation and completion', () => {
    const exec = executor();
    adapter.saveWorkflow(workflow('wf-hooks'));
    adapter.saveTask('wf-hooks', task('task-hooks', 'wf-hooks'));
    const attempt = createAttempt('task-hooks', {
      status: 'running',
      createdAt: new Date('2026-07-27T00:00:03.000Z'),
    });

    adapter.saveAttempt(attempt);
    adapter.updateTask('task-hooks', { status: 'running' });
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:00:04.000Z'),
    });

    const entries = readJournalSince(exec, 0, 100);
    const taskStatus = entries.find(
      (entry) => entry.entityType === 'task'
        && entry.entityId === 'task-hooks'
        && (entry.payload as { status?: unknown }).status === 'running',
    );
    const attemptEntries = entries.filter(
      (entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id,
    );

    expect(taskStatus?.op).toBe('upsert');
    expect(attemptEntries.map((entry) => (entry.payload as { status?: unknown }).status)).toEqual([
      'running',
      'completed',
    ]);
  });

  it('excludes soft-deleted workflows from default listings but includes them on request', () => {
    adapter.saveWorkflow(workflow('wf-soft-delete'));

    adapter.deleteWorkflow('wf-soft-delete');

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow('wf-soft-delete')).toBeUndefined();

    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    expect(withDeleted).toHaveLength(1);
    expect(withDeleted[0]).toMatchObject({
      id: 'wf-soft-delete',
      name: 'Workflow wf-soft-delete',
    });
    expect(withDeleted[0].deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-soft-delete', { includeDeleted: true })?.deletedAt)
      .toEqual(expect.any(Number));
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    const exec = executor();
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstones = readJournalSince(exec, 0, 100).filter(
      (entry) => entry.entityType === 'workflow'
        && entry.entityId === 'wf-tombstone'
        && entry.op === 'tombstone',
    );

    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].origin).toBe('home');
    expect(tombstones[0].payload as Record<string, unknown>).toMatchObject({
      id: 'wf-tombstone',
      deleted_at: expect.any(Number),
    });
  });
});

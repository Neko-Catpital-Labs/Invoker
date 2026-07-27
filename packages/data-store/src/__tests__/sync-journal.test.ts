import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, type TaskState } from '@invoker/workflow-core';
import type { WorkflowSaveInput } from '../adapter.js';
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
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function workflow(id = 'wf-1'): WorkflowSaveInput {
    return {
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  function task(id = 'task-1'): TaskState {
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

  it('fails loudly and rolls back the mutation when journal append fails', () => {
    const db = (adapter as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('simulated journal failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => adapter.saveWorkflow(workflow())).toThrow('simulated journal failure');
    } finally {
      db.run = originalRun;
    }

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(exec(), 0, 10)).toEqual([]);
  });

  it('rolls back journal rows with their enclosing transaction', () => {
    expect(() => adapter.runInTransaction(() => {
      adapter.saveWorkflow(workflow());
      throw new Error('rollback');
    })).toThrow('rollback');

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(exec(), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values across journaled mutations', () => {
    adapter.saveWorkflow(workflow());
    adapter.saveTask('wf-1', task());
    adapter.updateTask('task-1', { status: 'running' });
    const attempt = createAttempt('task-1', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:05:00.000Z'),
      exitCode: 0,
    });

    const seqs = readJournalSince(exec(), 0, 20).map((entry) => entry.seq);
    expect(seqs).toHaveLength(5);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    for (let i = 1; i < seqs.length; i += 1) {
      expect(seqs[i]).toBeGreaterThan(seqs[i - 1]);
    }
  });

  it('reads journal rows after the stored cursor', () => {
    const first = appendJournalEntry(exec(), {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
      createdAt: 1,
    });
    const second = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
      createdAt: 2,
    });
    const third = appendJournalEntry(exec(), {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1' },
      createdAt: 3,
    });

    setSyncCursor(exec(), {
      peerId: 'peer-a',
      lastSentSeq: second,
      lastReceivedSeq: first,
      updatedAt: 4,
    });

    const cursor = getSyncCursor(exec(), 'peer-a');
    expect(cursor).toMatchObject({ peerId: 'peer-a', lastSentSeq: second, lastReceivedSeq: first });
    expect(readJournalSince(exec(), cursor!.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([third]);
  });

  it('excludes soft-deleted workflows by default but includes them when requested', () => {
    adapter.saveWorkflow(workflow());
    adapter.deleteWorkflow('wf-1');

    expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
    expect(adapter.listWorkflows()).toEqual([]);

    const deleted = adapter.loadWorkflow('wf-1', { includeDeleted: true });
    expect(deleted?.id).toBe('wf-1');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((wf) => wf.id)).toEqual(['wf-1']);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(workflow());
    adapter.deleteWorkflow('wf-1');

    const tombstone = readJournalSince(exec(), 0, 10).find((entry) => entry.op === 'tombstone');
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-1',
      origin: 'home',
    });
    expect(tombstone?.payload).toMatchObject({
      id: 'wf-1',
      deleted_at: expect.any(Number),
    });
  });
});

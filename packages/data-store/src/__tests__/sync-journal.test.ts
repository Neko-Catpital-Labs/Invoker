import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
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

  const workflow: Workflow = {
    id: 'wf-sync',
    name: 'Sync Workflow',
    status: 'pending',
    createdAt: '2026-07-25T00:00:00.000Z',
    updatedAt: '2026-07-25T00:00:00.000Z',
  };

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function exec(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function clearJournal(): void {
    (adapter as unknown as { db: { run: (sql: string) => void } }).db.run('DELETE FROM sync_journal');
  }

  function seedWorkflowAndTask(): void {
    adapter.saveWorkflow(workflow);
    adapter.saveTask(
      workflow.id,
      createTaskState('task-sync', 'Task Sync', [], { workflowId: workflow.id }),
    );
    clearJournal();
  }

  it('rolls back the mutation when the journal append fails', () => {
    seedWorkflowAndTask();
    const db = (adapter as unknown as { db: { run: (sql: string, params?: unknown[]) => void } }).db;
    const originalRun = db.run.bind(db);
    db.run = (sql: string, params?: unknown[]) => {
      if (sql.includes('INSERT INTO sync_journal')) {
        throw new Error('simulated journal failure');
      }
      return originalRun(sql, params);
    };

    try {
      expect(() => adapter.updateTask('task-sync', { status: 'running' })).toThrow('simulated journal failure');
    } finally {
      db.run = originalRun;
    }

    expect(adapter.loadTask('task-sync')?.status).toBe('pending');
    expect(readJournalSince(exec(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic journal seq values', () => {
    const first = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1', status: 'pending' },
    });
    const second = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'task-2',
      op: 'upsert',
      payload: { id: 'task-2', status: 'running' },
    });
    const third = appendJournalEntry(exec(), {
      entityType: 'attempt',
      entityId: 'attempt-1',
      op: 'upsert',
      payload: { id: 'attempt-1', status: 'completed' },
    });

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(readJournalSince(exec(), 0, 10).map((entry) => entry.seq)).toEqual([first, second, third]);
  });

  it('reads journal entries after the cursor seq and persists peer cursors', () => {
    const first = appendJournalEntry(exec(), {
      entityType: 'workflow',
      entityId: 'wf-1',
      op: 'upsert',
      payload: { id: 'wf-1' },
    });
    const second = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'task-1',
      op: 'upsert',
      payload: { id: 'task-1' },
    });
    const third = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'task-2',
      op: 'upsert',
      payload: { id: 'task-2' },
    });

    expect(readJournalSince(exec(), first, 10).map((entry) => entry.seq)).toEqual([second, third]);

    setSyncCursor(exec(), {
      peerId: 'remote-a',
      lastSentSeq: second,
      lastReceivedSeq: 7,
      updatedAt: 1234,
    });
    expect(getSyncCursor(exec(), 'remote-a')).toEqual({
      peerId: 'remote-a',
      lastSentSeq: second,
      lastReceivedSeq: 7,
      updatedAt: 1234,
    });
    expect(readJournalSince(exec(), getSyncCursor(exec(), 'remote-a')!.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([third]);

    setSyncCursor(exec(), {
      peerId: 'remote-a',
      lastReceivedSeq: third,
      updatedAt: 5678,
    });
    expect(getSyncCursor(exec(), 'remote-a')).toMatchObject({
      lastSentSeq: second,
      lastReceivedSeq: third,
      updatedAt: 5678,
    });
  });

  it('excludes soft-deleted workflows by default and journals a tombstone', () => {
    seedWorkflowAndTask();

    adapter.deleteWorkflow(workflow.id);

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow(workflow.id)).toBeUndefined();
    const deleted = adapter.loadWorkflow(workflow.id, { includeDeleted: true })!;
    expect(deleted.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((row) => row.id)).toEqual([workflow.id]);

    const [entry] = readJournalSince(exec(), 0, 10);
    expect(entry).toMatchObject({
      entityType: 'workflow',
      entityId: workflow.id,
      op: 'tombstone',
      origin: 'home',
    });
    expect((entry.payload as Record<string, unknown>).deleted_at).toBe(deleted.deletedAt);
  });

  it('journals attempt creation and completion snapshots', () => {
    seedWorkflowAndTask();
    const attempt = createAttempt('task-sync', {
      status: 'running',
    });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-25T00:00:02.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(exec(), 0, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect((entries[1].payload as Record<string, unknown>).status).toBe('completed');
  });
});

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { Attempt, TaskState } from '@invoker/workflow-core';
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

  const testWorkflow: Workflow = {
    id: 'wf-sync',
    name: 'Sync Workflow',
    status: 'pending',
    createdAt: '2026-07-27T00:00:00.000Z',
    updatedAt: '2026-07-27T00:00:00.000Z',
  };

  function executor(): SqliteExecutor {
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-27T00:00:00.000Z'),
      config: { workflowId: testWorkflow.id },
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  it('rolls back journal appends with the enclosing mutation transaction', () => {
    expect(() =>
      adapter.runInTransaction(() => {
        adapter.saveWorkflow({ ...testWorkflow, id: 'wf-rollback' });
        throw new Error('rollback sentinel');
      }),
    ).toThrow(/rollback sentinel/);

    expect(adapter.loadWorkflow('wf-rollback')).toBeUndefined();
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a' },
    });

    expect(second.seq).toBeGreaterThan(first.seq);
    expect(third.seq).toBeGreaterThan(second.seq);
  });

  it('reads journal pages after the supplied cursor seq', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'task',
      entityId: 'task-a',
      op: 'upsert',
      payload: { id: 'task-a' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'attempt',
      entityId: 'attempt-a',
      op: 'upsert',
      payload: { id: 'attempt-a' },
    });

    const cursor = setSyncCursor(executor(), {
      peerId: 'remote-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: second.seq,
      updatedAt: '2026-07-27T00:00:01.000Z',
    });

    expect(getSyncCursor(executor(), 'remote-a')).toEqual(cursor);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 1).map((entry) => entry.seq)).toEqual([
      second.seq,
    ]);
    expect(readJournalSince(executor(), second.seq, 10).map((entry) => entry.seq)).toEqual([
      third.seq,
    ]);
  });

  it('excludes soft-deleted workflows by default and includes them when requested', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-delete'));

    adapter.deleteWorkflow(testWorkflow.id);

    expect(adapter.listWorkflows()).toEqual([]);
    const [deleted] = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toMatchObject({
      id: testWorkflow.id,
      name: testWorkflow.name,
    });
    expect(deleted.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow(testWorkflow.id, { includeDeleted: true })?.deletedAt).toBe(deleted.deletedAt);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-delete'));

    adapter.deleteWorkflow(testWorkflow.id);

    const tombstone = readJournalSince(executor(), 0, 10).find(
      (entry) =>
        entry.entityType === 'workflow' &&
        entry.entityId === testWorkflow.id &&
        entry.op === 'tombstone',
    );
    expect(tombstone).toBeDefined();
    expect(tombstone?.origin).toBe('home');
    expect((tombstone?.payload as { deleted_at?: number }).deleted_at).toEqual(expect.any(Number));
  });

  it('journals task status changes as upsert snapshots', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-status'));

    adapter.updateTask('task-status', { status: 'running' });

    const taskEntry = readJournalSince(executor(), 0, 10).find(
      (entry) => entry.entityType === 'task' && entry.entityId === 'task-status',
    );
    expect(taskEntry).toBeDefined();
    expect(taskEntry?.op).toBe('upsert');
    expect((taskEntry?.payload as { status?: string }).status).toBe('running');
  });

  it('journals attempt creation and completion snapshots', () => {
    adapter.saveWorkflow(testWorkflow);
    adapter.saveTask(testWorkflow.id, makeTask('task-attempt'));
    const attempt: Attempt = createAttempt('task-attempt', { status: 'running' });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-27T00:01:00.000Z'),
      exitCode: 0,
    });

    const attemptEntries = readJournalSince(executor(), 0, 20).filter(
      (entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id,
    );
    expect(attemptEntries.map((entry) => entry.op)).toEqual(['upsert', 'upsert']);
    expect((attemptEntries[1].payload as { status?: string }).status).toBe('completed');
  });
});

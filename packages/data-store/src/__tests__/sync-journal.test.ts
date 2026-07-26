import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
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

  function saveWorkflowAndTask(): void {
    adapter.saveWorkflow({
      id: 'wf-1',
      name: 'Sync workflow',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    });
    adapter.saveTask('wf-1', makeTask('t1'));
  }

  function lastSeq(): number {
    return readJournalSince(exec(), 0, 1_000).at(-1)?.seq ?? 0;
  }

  it('rolls back the mutation when its journal append fails', () => {
    saveWorkflowAndTask();
    const baselineSeq = lastSeq();
    (adapter as any).db.run(`
      CREATE TRIGGER fail_sync_journal
      BEFORE INSERT ON sync_journal
      BEGIN
        SELECT RAISE(ABORT, 'journal failure');
      END
    `);

    expect(() => adapter.updateTask('t1', { status: 'running' })).toThrow(/journal failure/);
    (adapter as any).db.run('DROP TRIGGER fail_sync_journal');

    expect(adapter.loadTask('t1')?.status).toBe('pending');
    expect(readJournalSince(exec(), baselineSeq, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values and reads after a cursor', () => {
    const first = appendJournalEntry(exec(), {
      entityType: 'workflow',
      entityId: 'manual-1',
      op: 'upsert',
      payload: { id: 'manual-1' },
    });
    const second = appendJournalEntry(exec(), {
      entityType: 'task',
      entityId: 'manual-2',
      op: 'upsert',
      payload: { id: 'manual-2' },
    });
    const third = appendJournalEntry(exec(), {
      entityType: 'event',
      entityId: 'manual-3',
      op: 'upsert',
      payload: { id: 'manual-3' },
    });

    expect([first, second, third]).toEqual([...new Set([first, second, third])]);
    expect(first).toBeLessThan(second);
    expect(second).toBeLessThan(third);
    expect(readJournalSince(exec(), first, 10).map((entry) => entry.seq)).toEqual([second, third]);
    expect(readJournalSince(exec(), first, 1).map((entry) => entry.seq)).toEqual([second]);
  });

  it('gets and sets per-peer cursor pairs', () => {
    expect(getSyncCursor(exec(), 'peer-a')).toBeUndefined();

    setSyncCursor(exec(), {
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-26T01:00:00.000Z',
    });

    expect(getSyncCursor(exec(), 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-26T01:00:00.000Z',
    });
  });

  it('excludes soft-deleted workflows by default and includes them explicitly', () => {
    saveWorkflowAndTask();

    adapter.deleteWorkflow('wf-1');

    expect(adapter.loadWorkflow('wf-1')).toBeUndefined();
    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual([]);
    const [deleted] = adapter.listWorkflows({ includeDeleted: true });
    expect(deleted).toMatchObject({
      id: 'wf-1',
      name: 'Sync workflow',
    });
    expect(typeof deleted.deletedAt).toBe('number');
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    saveWorkflowAndTask();
    const baselineSeq = lastSeq();

    adapter.deleteWorkflow('wf-1');

    const [tombstone] = readJournalSince(exec(), baselineSeq, 10)
      .filter((entry) => entry.entityType === 'workflow' && entry.op === 'tombstone');
    expect(tombstone).toBeDefined();
    expect(tombstone.entityId).toBe('wf-1');
    expect(tombstone.origin).toBe('home');
    expect(tombstone.payload).toMatchObject({
      id: 'wf-1',
      deleted_at: expect.any(Number),
    });
  });

  it('journals attempt creation and completion snapshots', () => {
    saveWorkflowAndTask();
    const baselineSeq = lastSeq();
    const attempt = createAttempt('t1', { status: 'running' });

    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T02:00:00.000Z'),
      exitCode: 0,
    });

    const attemptEntries = readJournalSince(exec(), baselineSeq, 10)
      .filter((entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id);
    expect(attemptEntries).toHaveLength(2);
    expect(attemptEntries.map((entry) => (entry.payload as { status: string }).status))
      .toEqual(['running', 'completed']);
  });
});

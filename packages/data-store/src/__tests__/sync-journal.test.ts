import { describe, it, expect, beforeEach, afterEach } from 'vitest';
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
    return (adapter as unknown as { executor: SqliteExecutor }).executor;
  }

  function rawDb(): { run(sql: string, params?: unknown[]): void } {
    return (adapter as unknown as { db: { run(sql: string, params?: unknown[]): void } }).db;
  }

  function makeWorkflow(id = 'wf-1'): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    };
  }

  function makeTask(id = 'task-1', workflowId = 'wf-1'): TaskState {
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

  function clearJournal(): void {
    rawDb().run('DELETE FROM sync_journal');
  }

  it('rolls back the mutation when the journal append fails', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    clearJournal();

    rawDb().run(`
      CREATE TRIGGER fail_sync_journal
      BEFORE INSERT ON sync_journal
      BEGIN
        SELECT RAISE(FAIL, 'journal fail');
      END
    `);

    expect(() => adapter.updateTask('task-1', { status: 'running' })).toThrow('journal fail');
    rawDb().run('DROP TRIGGER fail_sync_journal');

    expect(adapter.loadTask('task-1')?.status).toBe('pending');
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

    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it('reads journal rows after the supplied cursor and honors limit', () => {
    const first = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-a',
      op: 'upsert',
      payload: { id: 'wf-a' },
    });
    const second = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-b',
      op: 'upsert',
      payload: { id: 'wf-b' },
    });
    const third = appendJournalEntry(executor(), {
      entityType: 'workflow',
      entityId: 'wf-c',
      op: 'upsert',
      payload: { id: 'wf-c' },
    });

    expect(readJournalSince(executor(), first, 10).map((entry) => entry.seq)).toEqual([second, third]);
    expect(readJournalSince(executor(), 0, 2).map((entry) => entry.seq)).toEqual([first, second]);
  });

  it('gets and sets peer cursor pairs', () => {
    expect(getSyncCursor(executor(), 'peer-a')).toBeUndefined();

    setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: 1_722_000_000_000,
    });

    expect(getSyncCursor(executor(), 'peer-a')).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: 1_722_000_000_000,
    });
  });

  it('journals attempt creation and completion as row snapshots', () => {
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
    clearJournal();

    const attempt = createAttempt('task-1', {
      status: 'running',
      startedAt: new Date('2026-07-27T00:01:00.000Z'),
    });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      exitCode: 0,
      completedAt: new Date('2026-07-27T00:02:00.000Z'),
    });

    const entries = readJournalSince(executor(), 0, 10);
    expect(entries.map((entry) => [entry.entityType, entry.entityId, entry.op])).toEqual([
      ['attempt', attempt.id, 'upsert'],
      ['attempt', attempt.id, 'upsert'],
    ]);
    expect(entries[1].seq).toBeGreaterThan(entries[0].seq);
    expect(entries[1].payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      exit_code: 0,
    });
  });

  it('hides soft-deleted workflows by default and exposes them with includeDeleted', () => {
    adapter.saveWorkflow({
      ...makeWorkflow('wf-delete'),
      createdAt: '2026-07-27T00:00:00.000Z',
      updatedAt: '2026-07-27T00:00:00.000Z',
    });
    adapter.saveWorkflow({
      ...makeWorkflow('wf-keep'),
      createdAt: '2026-07-27T00:01:00.000Z',
      updatedAt: '2026-07-27T00:01:00.000Z',
    });
    clearJournal();

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((workflow) => workflow.id)).toEqual([
      'wf-keep',
      'wf-delete',
    ]);
  });

  it('writes a tombstone journal entry when deleting a workflow', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    clearJournal();

    adapter.deleteWorkflow('wf-delete');

    const [entry] = readJournalSince(executor(), 0, 10);
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

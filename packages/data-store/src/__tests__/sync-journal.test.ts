import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
  type SyncJournalDatabase,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function journalDb(): SyncJournalDatabase {
    return (adapter as any).executor as SyncJournalDatabase;
  }

  function makeWorkflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };
  }

  function makeTask(id: string, workflowId: string, status: TaskState['status'] = 'pending'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status,
      dependencies: [],
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      config: { workflowId },
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back a journal append with the mutation that created it', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(makeWorkflow('wf-rollback'));
        throw new Error('rollback sentinel');
      });
    }).toThrow(/rollback sentinel/);

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(journalDb(), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic journal seq values', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('task-1', 'wf-1'));
    adapter.updateTask('task-1', { status: 'running' });
    const attempt = createAttempt('task-1', {
      status: 'running',
      startedAt: new Date('2026-07-24T00:01:00.000Z'),
    });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-24T00:02:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(journalDb(), 0, 20);

    expect(entries.map((entry) => entry.entityType)).toEqual([
      'workflow',
      'task',
      'attempt',
      'attempt',
    ]);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
    }
  });

  it('reads journal entries after the supplied cursor', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveWorkflow(makeWorkflow('wf-2'));
    adapter.saveWorkflow(makeWorkflow('wf-3'));

    const entries = readJournalSince(journalDb(), 0, 10);
    setSyncCursor(journalDb(), {
      peerId: 'remote-a',
      lastSentSeq: entries[1].seq,
      lastReceivedSeq: 0,
      updatedAt: 1_786_755_600_000,
    });

    const cursor = getSyncCursor(journalDb(), 'remote-a');
    expect(cursor).toMatchObject({
      peerId: 'remote-a',
      lastSentSeq: entries[1].seq,
      lastReceivedSeq: 0,
    });
    expect(readJournalSince(journalDb(), cursor!.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      entries[2].seq,
    ]);
  });

  it('fails and rolls back the mutation when a journal append fails', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('task-1', 'wf-1'));
    (adapter as any).db.run('DROP TABLE sync_journal');

    expect(() => adapter.updateTask('task-1', { status: 'running' })).toThrow(/sync_journal/);
    expect(adapter.loadTask('task-1')?.status).toBe('pending');
  });

  it('excludes soft-deleted workflows from default listings but includes them when requested', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    adapter.saveWorkflow(makeWorkflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    const deleted = withDeleted.find((workflow) => workflow.id === 'wf-delete');
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toEqual(expect.any(Number));
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    const beforeDeleteSeq = readJournalSince(journalDb(), 0, 10).at(-1)!.seq;

    adapter.deleteWorkflow('wf-delete');

    const [tombstone] = readJournalSince(journalDb(), beforeDeleteSeq, 10);
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect((tombstone.payload as { deleted_at?: unknown }).deleted_at).toEqual(expect.any(Number));
  });
});

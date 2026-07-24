import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
  let exec: SqliteExecutor;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    exec = (adapter as unknown as { executor: SqliteExecutor }).executor;
  });

  afterEach(() => {
    adapter.close();
  });

  function makeWorkflow(id: string) {
    return {
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-24T00:00:00.000Z',
      updatedAt: '2026-07-24T00:00:00.000Z',
    };
  }

  function makeTask(id: string): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-24T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls back journal appends with their enclosing mutation', () => {
    expect(() => {
      exec.runTransaction(() => {
        exec.execRun(
          `INSERT INTO workflows (id, name, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
          ['wf-rollback', 'Rollback', '2026-07-24T00:00:00.000Z', '2026-07-24T00:00:00.000Z'],
        );
        appendJournalEntry(exec, {
          entityType: 'workflow',
          entityId: 'wf-rollback',
          op: 'upsert',
          payload: { id: 'wf-rollback', name: 'Rollback' },
        });
        throw new Error('rollback fixture');
      });
    }).toThrow('rollback fixture');

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(exec, 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic seq values', () => {
    appendJournalEntry(exec, { entityType: 'event', entityId: 'e1', op: 'upsert', payload: { id: 1 } });
    appendJournalEntry(exec, { entityType: 'event', entityId: 'e2', op: 'upsert', payload: { id: 2 } });
    appendJournalEntry(exec, { entityType: 'output', entityId: 'o1', op: 'upsert', payload: { id: 3 } });

    const seqs = readJournalSince(exec, 0, 10).map((entry) => entry.seq);

    expect(seqs).toHaveLength(3);
    expect(seqs[0]).toBeGreaterThan(0);
    expect(seqs[1]).toBeGreaterThan(seqs[0]);
    expect(seqs[2]).toBeGreaterThan(seqs[1]);
  });

  it('reads journal rows after a cursor and persists peer cursors', () => {
    appendJournalEntry(exec, { entityType: 'event', entityId: 'e1', op: 'upsert', payload: { id: 1 } });
    appendJournalEntry(exec, { entityType: 'event', entityId: 'e2', op: 'upsert', payload: { id: 2 } });
    appendJournalEntry(exec, { entityType: 'event', entityId: 'e3', op: 'upsert', payload: { id: 3 } });
    const entries = readJournalSince(exec, 0, 10);
    const second = entries[1];
    expect(second).toBeDefined();

    const cursor = setSyncCursor(exec, {
      peerId: 'peer-a',
      lastSentSeq: second!.seq,
      lastReceivedSeq: 17,
      updatedAt: '2026-07-24T01:02:03.000Z',
    });
    const rows = readJournalSince(exec, cursor.lastSentSeq, 10);

    expect(getSyncCursor(exec, 'peer-a')).toEqual(cursor);
    expect(rows.map((entry) => entry.entityId)).toEqual(['e3']);
  });

  it('journals task status changes and attempt creation/completion snapshots', () => {
    adapter.saveWorkflow(makeWorkflow('wf-1'));
    adapter.saveTask('wf-1', makeTask('t1'));
    adapter.updateTask('t1', { status: 'running' });

    const attempt = createAttempt('t1', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-24T02:00:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(exec, 0, 20);
    const taskStatusEntry = entries.find((entry) => entry.entityType === 'task' && entry.entityId === 't1' && (entry.payload as { status?: string }).status === 'running');
    const attemptCompletionEntry = entries.find((entry) => entry.entityType === 'attempt' && entry.entityId === attempt.id && (entry.payload as { status?: string }).status === 'completed');

    expect(taskStatusEntry?.op).toBe('upsert');
    expect(attemptCompletionEntry?.payload).toMatchObject({
      id: attempt.id,
      status: 'completed',
      completed_at: '2026-07-24T02:00:00.000Z',
    });
  });

  it('excludes soft-deleted workflows by default and includes them on request', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));
    adapter.saveWorkflow(makeWorkflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((workflow) => workflow.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const withDeleted = adapter.listWorkflows({ includeDeleted: true });
    const deleted = withDeleted.find((workflow) => workflow.id === 'wf-delete');
    expect(withDeleted.map((workflow) => workflow.id).sort()).toEqual(['wf-delete', 'wf-keep']);
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow('wf-delete', { includeDeleted: true })?.deletedAt).toBe(deleted?.deletedAt);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(makeWorkflow('wf-delete'));

    adapter.deleteWorkflow('wf-delete');

    const tombstones = readJournalSince(exec, 0, 20).filter(
      (entry) => entry.entityType === 'workflow' && entry.entityId === 'wf-delete' && entry.op === 'tombstone',
    );
    expect(tombstones).toHaveLength(1);
    expect(tombstones[0].origin).toBe('home');
    expect(tombstones[0].payload).toMatchObject({
      id: 'wf-delete',
      deleted_at: expect.any(Number),
    });
  });
});

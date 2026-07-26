import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt, createTaskState } from '@invoker/workflow-core';
import type { WorkflowSaveInput } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import type { SqliteExecutor } from '../sqlite-executor.js';
import {
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

  function workflow(id: string): WorkflowSaveInput {
    return {
      id,
      name: `Workflow ${id}`,
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    };
  }

  function saveWorkflowAndTask(workflowId = 'wf-1', taskId = 'task-1'): void {
    adapter.saveWorkflow(workflow(workflowId));
    adapter.saveTask(
      workflowId,
      createTaskState(taskId, `Task ${taskId}`, [], { workflowId }),
    );
  }

  it('rolls back journal rows with the enclosing mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(workflow('wf-rollback'));
        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('fails the enclosing mutation when a journal append fails', () => {
    saveWorkflowAndTask();
    (adapter as unknown as { db: { run: (sql: string) => void } }).db.run('DROP TABLE sync_journal');

    expect(() => adapter.updateTask('task-1', { status: 'running' })).toThrow(/sync_journal/);
    expect(adapter.loadTask('task-1')?.status).toBe('pending');
  });

  it('assigns strictly monotonic seq values for journaled mutations', () => {
    saveWorkflowAndTask();
    adapter.updateTask('task-1', { status: 'running' });
    const attempt = createAttempt('task-1', { status: 'running' });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T00:01:00.000Z'),
    });

    const entries = readJournalSince(executor(), 0, 20);
    expect(entries.map((entry) => entry.entityType)).toEqual([
      'workflow',
      'task',
      'task',
      'attempt',
      'attempt',
    ]);
    for (let i = 1; i < entries.length; i += 1) {
      expect(entries[i].seq).toBeGreaterThan(entries[i - 1].seq);
    }
  });

  it('reads journal rows after a cursor and stores peer cursor pairs', () => {
    adapter.saveWorkflow(workflow('wf-a'));
    adapter.saveWorkflow(workflow('wf-b'));
    adapter.saveWorkflow(workflow('wf-c'));

    const [first] = readJournalSince(executor(), 0, 1);
    const cursor = setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: first.seq,
      lastReceivedSeq: 42,
      updatedAt: 123456,
    });

    expect(getSyncCursor(executor(), 'peer-a')).toEqual(cursor);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 10).map((entry) => entry.entityId)).toEqual([
      'wf-b',
      'wf-c',
    ]);
  });

  it('excludes soft-deleted workflows by default but includes them explicitly', () => {
    adapter.saveWorkflow(workflow('wf-delete'));
    adapter.saveWorkflow(workflow('wf-keep'));

    adapter.deleteWorkflow('wf-delete');

    expect(adapter.listWorkflows().map((wf) => wf.id)).toEqual(['wf-keep']);
    expect(adapter.loadWorkflow('wf-delete')).toBeUndefined();

    const deleted = adapter.loadWorkflow('wf-delete', { includeDeleted: true });
    expect(deleted?.deletedAt).toEqual(expect.any(Number));
    expect(adapter.listWorkflows({ includeDeleted: true }).map((wf) => wf.id).sort()).toEqual([
      'wf-delete',
      'wf-keep',
    ]);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(workflow('wf-delete'));

    adapter.deleteWorkflow('wf-delete');

    const tombstone = readJournalSince(executor(), 0, 10).find((entry) => entry.op === 'tombstone');
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-delete',
      op: 'tombstone',
      origin: 'home',
    });
    expect((tombstone?.payload as { deleted_at?: unknown }).deleted_at).toEqual(expect.any(Number));
  });
});

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { Attempt, TaskState } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
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

  function workflow(id: string): Workflow {
    return {
      id,
      name: `Workflow ${id}`,
      status: 'pending',
      createdAt: '2026-07-26T00:00:00.000Z',
      updatedAt: '2026-07-26T00:00:00.000Z',
    };
  }

  function task(id: string, status: TaskState['status'] = 'pending'): TaskState {
    return {
      id,
      description: `Task ${id}`,
      status,
      dependencies: [],
      createdAt: new Date('2026-07-26T00:00:00.000Z'),
      config: {},
      execution: {},
      taskStateVersion: 1,
    };
  }

  it('rolls journal appends back with the enclosing mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(workflow('wf-rollback'));
        adapter.saveTask('wf-rollback', task('wf-rollback/t1'));
        adapter.updateTask('wf-rollback/t1', { status: 'running' });
        throw new Error('rollback');
      });
    }).toThrow('rollback');

    expect(adapter.loadWorkflow('wf-rollback', { includeDeleted: true })).toBeUndefined();
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('assigns strictly monotonic journal seq values', () => {
    adapter.saveWorkflow(workflow('wf-seq'));
    adapter.saveTask('wf-seq', task('wf-seq/t1'));
    adapter.updateTask('wf-seq/t1', { status: 'running' });

    const attempt = createAttempt('wf-seq/t1', { status: 'running' }) as Attempt;
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-26T00:01:00.000Z'),
      exitCode: 0,
    });

    const entries = readJournalSince(executor(), 0, 20);
    expect(entries).toHaveLength(5);
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it('reads journal entries after the supplied cursor and persists peer cursors', () => {
    adapter.saveWorkflow(workflow('wf-cursor'));
    adapter.saveTask('wf-cursor', task('wf-cursor/t1'));
    adapter.updateTask('wf-cursor/t1', { status: 'running' });

    const entries = readJournalSince(executor(), 0, 10);
    const cursor = setSyncCursor(executor(), {
      peerId: 'remote-a',
      lastSentSeq: entries[1].seq,
      lastReceivedSeq: 7,
      updatedAt: 123456,
    });

    expect(getSyncCursor(executor(), 'remote-a')).toEqual(cursor);
    expect(readJournalSince(executor(), cursor.lastSentSeq, 10).map((entry) => entry.seq)).toEqual([
      entries[2].seq,
    ]);
  });

  it('excludes soft-deleted workflows from default reads and includes them on request', () => {
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
    adapter.saveWorkflow(workflow('wf-tombstone'));

    adapter.deleteWorkflow('wf-tombstone');

    const tombstone = readJournalSince(executor(), 0, 10).find((entry) => entry.op === 'tombstone');
    expect(tombstone).toMatchObject({
      entityType: 'workflow',
      entityId: 'wf-tombstone',
      op: 'tombstone',
      origin: 'home',
    });
    expect((tombstone?.payload as { deleted_at?: unknown }).deleted_at).toEqual(expect.any(Number));
  });
});

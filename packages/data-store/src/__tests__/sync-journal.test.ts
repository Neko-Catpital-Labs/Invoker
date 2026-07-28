import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createAttempt } from '@invoker/workflow-core';
import type { TaskState } from '@invoker/workflow-core';
import type { Workflow } from '../adapter.js';
import { SQLiteAdapter } from '../sqlite-adapter.js';
import {
  appendJournalEntry,
  getSyncCursor,
  readJournalSince,
  setSyncCursor,
} from '../sync-journal.js';

describe('sync journal', () => {
  let adapter: SQLiteAdapter;

  const workflow: Workflow = {
    id: 'wf-sync',
    name: 'Sync Workflow',
    status: 'pending',
    createdAt: '2026-07-28T00:00:00.000Z',
    updatedAt: '2026-07-28T00:00:00.000Z',
  };

  function makeTask(id: string, overrides: Partial<TaskState> = {}): TaskState {
    return {
      id,
      description: id,
      status: 'pending',
      dependencies: [],
      createdAt: new Date('2026-07-28T00:00:00.000Z'),
      config: { workflowId: workflow.id },
      execution: {},
      taskStateVersion: 1,
      ...overrides,
    };
  }

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  function executor() {
    return (adapter as unknown as { executor: Parameters<typeof readJournalSince>[0] }).executor;
  }

  it('rolls journal appends back with the enclosing mutation transaction', () => {
    expect(() => {
      adapter.runInTransaction(() => {
        adapter.saveWorkflow(workflow);
        throw new Error('rollback sentinel');
      });
    }).toThrow(/rollback sentinel/);

    expect(adapter.listWorkflows({ includeDeleted: true })).toEqual([]);
    expect(readJournalSince(executor(), 0, 10)).toEqual([]);
  });

  it('allocates strictly monotonic seq values for journaled mutations', () => {
    adapter.saveWorkflow(workflow);
    adapter.saveTask(workflow.id, makeTask('wf-sync/task-1'));
    adapter.updateTask('wf-sync/task-1', { status: 'running' });
    const attempt = createAttempt('wf-sync/task-1', {
      status: 'running',
      startedAt: new Date('2026-07-28T00:01:00.000Z'),
    });
    adapter.saveAttempt(attempt);
    adapter.updateAttempt(attempt.id, {
      status: 'completed',
      completedAt: new Date('2026-07-28T00:02:00.000Z'),
      exitCode: 0,
    });

    const entries = adapter.readJournalSince(0, 20);
    expect(entries.map((entry) => `${entry.entityType}:${entry.op}`)).toEqual([
      'workflow:upsert',
      'task:upsert',
      'attempt:upsert',
      'attempt:upsert',
    ]);
    for (let index = 1; index < entries.length; index += 1) {
      expect(entries[index]!.seq).toBeGreaterThan(entries[index - 1]!.seq);
    }
  });

  it('reads journal entries after the supplied cursor and honors limit', () => {
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

    expect(readJournalSince(executor(), 0, 2).map((entry) => entry.seq)).toEqual([first, second]);
    expect(readJournalSince(executor(), second, 10).map((entry) => entry.seq)).toEqual([third]);
  });

  it('gets and sets per-peer sync cursors', () => {
    expect(getSyncCursor(executor(), 'peer-a')).toBeUndefined();

    expect(setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-28T00:03:00.000Z',
    })).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 7,
      updatedAt: '2026-07-28T00:03:00.000Z',
    });

    expect(setSyncCursor(executor(), {
      peerId: 'peer-a',
      lastReceivedSeq: 9,
      updatedAt: '2026-07-28T00:04:00.000Z',
    })).toEqual({
      peerId: 'peer-a',
      lastSentSeq: 12,
      lastReceivedSeq: 9,
      updatedAt: '2026-07-28T00:04:00.000Z',
    });
  });

  it('excludes soft-deleted workflows by default and includes them on request', () => {
    adapter.saveWorkflow(workflow);

    adapter.deleteWorkflow(workflow.id);

    expect(adapter.listWorkflows()).toEqual([]);
    expect(adapter.loadWorkflow(workflow.id)).toBeUndefined();

    const deletedFromList = adapter.listWorkflows({ includeDeleted: true });
    expect(deletedFromList).toHaveLength(1);
    expect(deletedFromList[0]).toMatchObject({
      id: workflow.id,
      name: workflow.name,
    });
    expect(deletedFromList[0]!.deletedAt).toEqual(expect.any(Number));
    expect(adapter.loadWorkflow(workflow.id, { includeDeleted: true })?.deletedAt)
      .toBe(deletedFromList[0]!.deletedAt);
  });

  it('writes a workflow tombstone journal entry on delete', () => {
    adapter.saveWorkflow(workflow);
    adapter.deleteWorkflow(workflow.id);

    const tombstone = adapter.readJournalSince(0, 10)
      .find((entry) => entry.entityType === 'workflow' && entry.op === 'tombstone');

    expect(tombstone).toBeDefined();
    expect(tombstone).toMatchObject({
      entityId: workflow.id,
      origin: 'home',
    });
    expect(tombstone!.payload).toMatchObject({
      id: workflow.id,
      deleted_at: expect.any(Number),
    });
  });
});

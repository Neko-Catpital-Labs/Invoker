import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter, getSyncCursor, readJournalSince, setSyncCursor } from '@invoker/data-store';
import type { WorkflowSaveInput } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { SshSyncChannel } from '../ssh-sync-channel.js';
import {
  serializeRemoteProgressJournalEntry,
  type RemoteProgressJournalKind,
} from '../remote-progress-journal.js';
import type { SshExecOpts } from '../ssh-git-exec.js';

const T0 = '2026-07-28T00:00:00.000Z';
const T1 = '2026-07-28T00:00:01.000Z';
const T2 = '2026-07-28T00:00:02.000Z';
const T3 = '2026-07-28T00:00:03.000Z';

interface SqliteExecutor {
  queryOne(sql: string, params?: unknown[]): Record<string, unknown> | undefined;
  queryAll(sql: string, params?: unknown[]): Record<string, unknown>[];
  execRun(sql: string, params?: unknown[]): void;
  runTransaction<T>(work: () => T): T;
  run(sql: string, params?: unknown[]): void;
  getRowsModified(): number;
  readonly readOnly: boolean;
  markDirty(): void;
}

function executor(adapter: SQLiteAdapter): SqliteExecutor {
  return (adapter as unknown as { executor: SqliteExecutor }).executor;
}

function makeWorkflow(id = 'wf-1'): WorkflowSaveInput {
  return {
    id,
    name: `Workflow ${id}`,
    createdAt: T0,
    updatedAt: T0,
  };
}

function makeTask(id = 'task-1'): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'running',
    dependencies: [],
    createdAt: new Date(T0),
    config: { workflowId: 'wf-1', runnerKind: 'ssh' },
    execution: { generation: 0, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
  };
}

function remoteLine(
  seq: number,
  kind: RemoteProgressJournalKind,
  payload: Record<string, unknown> = {},
): string {
  return serializeRemoteProgressJournalEntry({
    seq,
    kind,
    workflowId: 'wf-1',
    taskId: 'task-1',
    attemptId: 'attempt-1',
    executionId: 'exec-1',
    createdAt: [T0, T1, T2, T3][seq] ?? T3,
    payload,
  });
}

function journal(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

function makeChannel(
  adapter: SQLiteAdapter,
  execRemoteCapture: (opts: SshExecOpts) => Promise<string>,
): SshSyncChannel {
  return new SshSyncChannel({
    host: 'remote.example.test',
    user: 'invoker',
    sshKeyPath: '/tmp/id_ed25519',
    port: 2222,
    db: executor(adapter),
    peerId: 'ssh-test-remote',
    execRemoteCapture,
  });
}

describe('SshSyncChannel', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    adapter.saveWorkflow(makeWorkflow());
    adapter.saveTask('wf-1', makeTask());
  });

  afterEach(() => {
    adapter.close();
  });

  it('advances the receive cursor after a successful pull', async () => {
    const execRemoteCapture = vi.fn(async () => journal([
      remoteLine(1, 'attempt_started', { status: 'running' }),
      remoteLine(2, 'heartbeat', { status: 'running' }),
      remoteLine(3, 'attempt_finished', { status: 'completed', exitCode: 0 }),
    ]));
    const channel = makeChannel(adapter, execRemoteCapture);

    const result = await channel.pull();

    expect(result.cursor.lastReceivedSeq).toBe(3);
    expect(getSyncCursor(executor(adapter), 'ssh-test-remote')?.lastReceivedSeq).toBe(3);
    expect(adapter.loadAttempt('attempt-1')?.status).toBe('completed');
    expect(adapter.loadTask('task-1')?.status).toBe('completed');
    expect(execRemoteCapture).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'ssh_sync_pull',
      sshArgs: expect.arrayContaining(['-p', '2222', 'invoker@remote.example.test']),
    }));
  });

  it('does not advance the receive cursor when transport fails', async () => {
    setSyncCursor(executor(adapter), {
      peerId: 'ssh-test-remote',
      lastReceivedSeq: 7,
      lastSentSeq: 3,
    });
    const execRemoteCapture = vi.fn(async () => {
      throw new Error('network down');
    });
    const channel = makeChannel(adapter, execRemoteCapture);

    await expect(channel.pull()).rejects.toThrow(/network down/);

    expect(getSyncCursor(executor(adapter), 'ssh-test-remote')).toMatchObject({
      lastReceivedSeq: 7,
      lastSentSeq: 3,
    });
    expect(adapter.loadAttempt('attempt-1')).toBeUndefined();
  });

  it('applies duplicate pulls idempotently', async () => {
    const remoteJournal = journal([
      remoteLine(1, 'attempt_started', { status: 'running' }),
      remoteLine(2, 'output_chunk', { offset: 0, data: 'hello\n' }),
      remoteLine(3, 'attempt_finished', { status: 'completed', exitCode: 0 }),
    ]);
    const execRemoteCapture = vi.fn(async () => remoteJournal);
    const channel = makeChannel(adapter, execRemoteCapture);

    await channel.pull();
    const afterFirstJournalCount = readJournalSince(executor(adapter), 0, 100)
      .filter((entry) => entry.origin === 'ssh-test-remote')
      .length;
    await channel.pull();

    const rows = executor(adapter).queryAll('SELECT offset, data FROM output_spool ORDER BY offset ASC');
    expect(rows).toEqual([{ offset: 0, data: 'hello\n' }]);
    expect(adapter.loadAttempt('attempt-1')?.status).toBe('completed');
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'ssh-test-remote')).toHaveLength(
      afterFirstJournalCount,
    );
    expect(getSyncCursor(executor(adapter), 'ssh-test-remote')?.lastReceivedSeq).toBe(3);
  });

  it('catches up exactly the entries missed while disconnected', async () => {
    const firstExec = vi.fn(async () => journal([
      remoteLine(1, 'attempt_started', { status: 'running' }),
    ]));
    await makeChannel(adapter, firstExec).pull();

    const reconnectExec = vi.fn(async () => journal([
      remoteLine(1, 'attempt_started', { status: 'running' }),
      remoteLine(2, 'output_chunk', { offset: 0, data: 'one\n' }),
      remoteLine(3, 'output_chunk', { offset: 4, data: 'two\n' }),
      remoteLine(4, 'attempt_finished', { status: 'completed', exitCode: 0 }),
    ]));

    await makeChannel(adapter, reconnectExec).pull();

    expect(getSyncCursor(executor(adapter), 'ssh-test-remote')?.lastReceivedSeq).toBe(4);
    expect(adapter.loadAttempt('attempt-1')?.status).toBe('completed');
    expect(executor(adapter).queryAll('SELECT offset, data FROM output_spool ORDER BY offset ASC')).toEqual([
      { offset: 0, data: 'one\n' },
      { offset: 4, data: 'two\n' },
    ]);
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'ssh-test-remote')).toHaveLength(4);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter, getSyncCursor, readJournalSince } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowSaveInput } from '@invoker/data-store';
import { SshSyncChannel, type SshSyncChannelConfig } from '../ssh-sync-channel.js';
import {
  REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
  type RemoteProgressJournalEntry,
} from '../remote-progress-journal.js';

const T0 = '2026-07-28T00:00:00.000Z';
const T1 = '2026-07-28T00:00:01.000Z';
const T2 = '2026-07-28T00:00:02.000Z';
const T3 = '2026-07-28T00:00:03.000Z';

function executor(adapter: SQLiteAdapter): SshSyncChannelConfig['store'] {
  return (adapter as unknown as { executor: SshSyncChannelConfig['store'] }).executor;
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
    status: 'pending',
    dependencies: [],
    createdAt: new Date(T0),
    config: { workflowId: 'wf-1' },
    execution: { generation: 0 },
    taskStateVersion: 1,
  };
}

function seed(adapter: SQLiteAdapter): void {
  adapter.saveWorkflow(makeWorkflow('wf-1'));
  adapter.saveTask('wf-1', makeTask('task-1'));
}

function remoteEntry(
  seq: number,
  kind: RemoteProgressJournalEntry['kind'],
  createdAt: string,
  payload: Record<string, unknown> = {},
): RemoteProgressJournalEntry {
  return {
    schemaVersion: REMOTE_PROGRESS_JOURNAL_SCHEMA_VERSION,
    seq,
    kind,
    taskId: 'task-1',
    attemptId: 'task-1-a1',
    workflowId: 'wf-1',
    createdAt,
    payload,
  };
}

function line(entry: RemoteProgressJournalEntry): string {
  return JSON.stringify(entry);
}

function sinceFromScript(script: string): number {
  const match = script.match(/SINCE_SEQ=(\d+)/);
  return Number(match?.[1] ?? 0);
}

function makeChannel(
  adapter: SQLiteAdapter,
  execRemoteCapture: SshSyncChannelConfig['execRemoteCapture'],
): SshSyncChannel {
  return new SshSyncChannel({
    host: 'remote.example.com',
    user: 'invoker',
    sshKeyPath: '/tmp/test-key',
    port: 2222,
    remoteInvokerHome: '/srv/invoker',
    peerId: 'remote-a',
    store: executor(adapter),
    execRemoteCapture,
  });
}

describe('SshSyncChannel', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    seed(adapter);
  });

  afterEach(() => {
    adapter.close();
  });

  it('advances the receive cursor after a successful pull', async () => {
    const remoteEntries = [
      remoteEntry(1, 'attempt_started', T1, { workspacePath: '/srv/wt', branch: 'experiment/task-1' }),
      remoteEntry(2, 'heartbeat', T2, { epoch: 1 }),
    ];
    const execRemoteCapture = vi.fn(async (opts) => {
      expect(opts.phase).toBe('ssh_sync_pull');
      expect(opts.sshArgs).toContain('/tmp/test-key');
      expect(opts.sshArgs).toContain('2222');
      return remoteEntries.filter((entry) => entry.seq > sinceFromScript(opts.script)).map(line).join('\n');
    });
    const channel = makeChannel(adapter, execRemoteCapture);

    const result = await channel.pull();

    expect(result.applyResult.lastReceivedSeq).toBe(2);
    expect(getSyncCursor(executor(adapter), 'remote-a')?.lastReceivedSeq).toBe(2);
    const attempt = executor(adapter).queryOne('SELECT status, last_heartbeat_at FROM attempts WHERE id = ?', [
      'task-1-a1',
    ]);
    expect(attempt).toMatchObject({ status: 'running', last_heartbeat_at: T2 });
  });

  it('does not advance the receive cursor when transport fails', async () => {
    const execRemoteCapture = vi.fn(async () => {
      throw new Error('network down');
    });
    const channel = makeChannel(adapter, execRemoteCapture);

    await expect(channel.pull()).rejects.toThrow('network down');

    expect(getSyncCursor(executor(adapter), 'remote-a')).toBeUndefined();
    expect(executor(adapter).queryOne('SELECT id FROM attempts WHERE id = ?', ['task-1-a1'])).toBeUndefined();
  });

  it('applies a duplicate pull idempotently', async () => {
    const remoteEntries = [
      remoteEntry(1, 'attempt_started', T1, { workspacePath: '/srv/wt' }),
      remoteEntry(2, 'heartbeat', T2),
    ];
    const execRemoteCapture = vi.fn(async () => remoteEntries.map(line).join('\n'));
    const channel = makeChannel(adapter, execRemoteCapture);

    const first = await channel.pull();
    const second = await channel.pull();

    expect(first.applyResult.appliedEntries).toBe(2);
    expect(second.applyResult.appliedEntries).toBe(0);
    expect(getSyncCursor(executor(adapter), 'remote-a')?.lastReceivedSeq).toBe(2);
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'remote-a')).toHaveLength(2);
  });

  it('resumes after reconnect and applies exactly the missed entries', async () => {
    const remoteEntries = [
      remoteEntry(1, 'attempt_started', T1, { workspacePath: '/srv/wt' }),
    ];
    const seenSince: number[] = [];
    const execRemoteCapture = vi.fn(async (opts) => {
      const since = sinceFromScript(opts.script);
      seenSince.push(since);
      return remoteEntries.filter((entry) => entry.seq > since).map(line).join('\n');
    });

    const firstChannel = makeChannel(adapter, execRemoteCapture);
    await firstChannel.pull();
    await firstChannel.stop();

    remoteEntries.push(remoteEntry(2, 'heartbeat', T2), remoteEntry(3, 'heartbeat', T3));

    const reconnectedChannel = makeChannel(adapter, execRemoteCapture);
    const catchUp = await reconnectedChannel.pull();

    expect(seenSince).toEqual([0, 1]);
    expect(catchUp.applyResult.appliedEntries).toBe(2);
    expect(getSyncCursor(executor(adapter), 'remote-a')?.lastReceivedSeq).toBe(3);
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'remote-a')).toHaveLength(3);
    const attempt = executor(adapter).queryOne('SELECT last_heartbeat_at FROM attempts WHERE id = ?', [
      'task-1-a1',
    ]);
    expect(attempt).toMatchObject({ last_heartbeat_at: T3 });
  });
});

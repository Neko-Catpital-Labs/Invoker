import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getSyncCursor,
  readJournalSince,
  SQLiteAdapter,
} from '@invoker/data-store';
import { SshSyncChannel } from '../ssh-sync-channel.js';
import type { SshExecOpts } from '../ssh-git-exec.js';
import type { RemoteProgressJournalEntry } from '../remote-progress-journal.js';

type SyncDb = Parameters<typeof getSyncCursor>[0];

const T0 = '2026-07-28T00:00:00.000Z';
const T1 = '2026-07-28T00:00:01.000Z';
const T2 = '2026-07-28T00:00:02.000Z';

function executor(adapter: SQLiteAdapter): SyncDb {
  return (adapter as unknown as { executor: SyncDb }).executor;
}

function remoteTaskEntry(
  seq: number,
  status: 'running' | 'completed' | 'failed',
  createdAt: string,
): RemoteProgressJournalEntry {
  return {
    schemaVersion: 1,
    seq,
    kind: status === 'running' ? 'heartbeat' : 'attempt_finished',
    entityType: 'task',
    entityId: 'wf-1/task-1',
    op: 'upsert',
    origin: 'remote',
    createdAt,
    payload: {
      id: 'wf-1/task-1',
      workflow_id: 'wf-1',
      description: 'Remote task',
      status,
      dependencies: '[]',
      created_at: T0,
      started_at: status === 'running' ? createdAt : T1,
      completed_at: status === 'running' ? null : createdAt,
      execution_generation: 0,
      task_state_version: seq,
    },
  };
}

function ndjson(entries: RemoteProgressJournalEntry[]): string {
  return entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n';
}

function makeChannel(
  adapter: SQLiteAdapter,
  execRemoteCapture: (opts: SshExecOpts) => Promise<string>,
): SshSyncChannel {
  return new SshSyncChannel({
    host: 'remote.example',
    user: 'runner',
    sshKeyPath: '/dev/null',
    port: 2222,
    db: executor(adapter),
    peerId: 'ssh:remote-1',
    remoteInvokerHome: '~/.invoker',
    execRemoteCapture,
  });
}

describe('SshSyncChannel', () => {
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(() => {
    adapter.close();
  });

  it('advances the receive cursor on successful pull', async () => {
    const execRemoteCapture = vi.fn(async () => ndjson([
      remoteTaskEntry(1, 'running', T1),
    ]));
    const channel = makeChannel(adapter, execRemoteCapture);

    const result = await channel.pullOnce();

    expect(result.appliedEntries).toBe(1);
    expect(getSyncCursor(executor(adapter), 'ssh:remote-1')?.lastReceivedSeq).toBe(1);
    expect(adapter.loadTask('wf-1/task-1')?.status).toBe('running');
    expect(execRemoteCapture.mock.calls[0]?.[0].sshArgs).toContain('runner@remote.example');
  });

  it('does not advance the receive cursor when transport fails', async () => {
    const execRemoteCapture = vi.fn(async () => {
      throw new Error('network down');
    });
    const channel = makeChannel(adapter, execRemoteCapture);

    await expect(channel.pullOnce()).rejects.toThrow(/network down/);

    expect(getSyncCursor(executor(adapter), 'ssh:remote-1')).toBeUndefined();
    expect(adapter.loadTask('wf-1/task-1')).toBeUndefined();
  });

  it('applies duplicate pull delivery idempotently', async () => {
    const execRemoteCapture = vi.fn(async () => ndjson([
      remoteTaskEntry(1, 'running', T1),
    ]));
    const channel = makeChannel(adapter, execRemoteCapture);

    const first = await channel.pullOnce();
    const second = await channel.pullOnce();

    expect(first.appliedEntries).toBe(1);
    expect(second.appliedEntries).toBe(0);
    expect(getSyncCursor(executor(adapter), 'ssh:remote-1')?.lastReceivedSeq).toBe(1);
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'ssh:remote-1')).toHaveLength(1);
  });

  it('catches up after disconnect and applies exactly the missed entries', async () => {
    const remoteEntries = [
      remoteTaskEntry(1, 'running', T1),
      remoteTaskEntry(2, 'running', '2026-07-28T00:00:01.500Z'),
      remoteTaskEntry(3, 'completed', T2),
    ];
    let connected = true;
    const execRemoteCapture = vi.fn(async () => {
      if (!connected) {
        throw new Error('ssh disconnected');
      }
      return ndjson(remoteEntries);
    });
    const channel = makeChannel(adapter, execRemoteCapture);

    await channel.pullOnce();
    connected = false;
    await expect(channel.pullOnce()).rejects.toThrow(/ssh disconnected/);
    expect(getSyncCursor(executor(adapter), 'ssh:remote-1')?.lastReceivedSeq).toBe(1);

    connected = true;
    const catchUp = await channel.pullOnce();

    expect(catchUp.appliedEntries).toBe(2);
    expect(getSyncCursor(executor(adapter), 'ssh:remote-1')?.lastReceivedSeq).toBe(3);
    expect(adapter.loadTask('wf-1/task-1')?.status).toBe('completed');
    expect(readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'ssh:remote-1')).toHaveLength(3);
  });
});

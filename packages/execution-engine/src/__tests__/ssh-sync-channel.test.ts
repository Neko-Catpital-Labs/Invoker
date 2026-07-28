import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter, getSyncCursor, readJournalSince } from '@invoker/data-store';
import type { SyncJournalEntry } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import { SshSyncChannel } from '../ssh-sync-channel.js';
import { SSH_SYNC_PUSH_ACK_PREFIX } from '../remote-progress-journal.js';
import type { SshExecOpts } from '../ssh-git-exec.js';

const T0 = '2026-07-28T00:00:00.000Z';
const T1 = '2026-07-28T00:00:01.000Z';
const T2 = '2026-07-28T00:00:02.000Z';
const T3 = '2026-07-28T00:00:03.000Z';

type Store = Parameters<typeof readJournalSince>[0];

function executor(adapter: SQLiteAdapter): Store {
  return (adapter as unknown as { executor: Store }).executor;
}

function b64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function makeTask(id = 'task-1'): TaskState {
  return {
    id,
    description: `Task ${id}`,
    status: 'running',
    dependencies: [],
    createdAt: new Date(T0),
    config: { workflowId: 'wf-1' },
    execution: { generation: 0, selectedAttemptId: 'attempt-1' },
    taskStateVersion: 1,
  };
}

function seed(adapter: SQLiteAdapter): void {
  adapter.saveWorkflow({
    id: 'wf-1',
    name: 'Workflow',
    createdAt: T0,
    updatedAt: T0,
  });
  adapter.saveTask('wf-1', makeTask());
}

function remoteLine(
  seq: number,
  kind: 'attempt_started' | 'heartbeat' | 'output' | 'attempt_finished',
  createdAt: string,
  payload: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    seq,
    kind,
    taskIdB64: b64('task-1'),
    attemptIdB64: b64('attempt-1'),
    workflowIdB64: b64('wf-1'),
    createdAt,
    payload,
  });
}

function fakePullExec(lines: () => string[], opts: { ignoreSince?: boolean } = {}) {
  return vi.fn(async (execOpts: SshExecOpts) => {
    if (execOpts.phase === 'ssh_sync_push') {
      const highWater = execOpts.script.match(new RegExp(`${SSH_SYNC_PUSH_ACK_PREFIX}(\\d+)`))?.[1] ?? '0';
      return `${SSH_SYNC_PUSH_ACK_PREFIX}${highWater}\n`;
    }
    const since = Number(execOpts.script.match(/SINCE_SEQ=(\d+)/)?.[1] ?? 0);
    const selected = lines().filter((line) => {
      if (opts.ignoreSince) return true;
      const parsed = JSON.parse(line) as { seq: number };
      return parsed.seq > since;
    });
    return selected.length > 0 ? `${selected.join('\n')}\n` : '';
  });
}

function outputRows(adapter: SQLiteAdapter): Record<string, unknown>[] {
  return executor(adapter).queryAll('SELECT task_id, offset, data FROM output_spool ORDER BY offset ASC');
}

function importedEntries(adapter: SQLiteAdapter): SyncJournalEntry[] {
  return readJournalSince(executor(adapter), 0, 100).filter((entry) => entry.origin === 'remote-a');
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

  function channel(remoteExec: ReturnType<typeof fakePullExec>): SshSyncChannel {
    return new SshSyncChannel({
      peerId: 'remote-a',
      store: executor(adapter),
      host: 'example.com',
      user: 'invoker',
      sshKeyPath: '/dev/null',
      remoteExec,
      intervalMs: 1000,
    });
  }

  it('advances the receive cursor after a successful pull', async () => {
    const remoteExec = fakePullExec(() => [
      remoteLine(1, 'attempt_started', T1, { branchB64: b64('experiment/task-1') }),
    ]);

    const result = await channel(remoteExec).pull();

    expect(result).toMatchObject({
      sinceSeq: 0,
      highWaterSeq: 1,
      receivedEntries: 1,
      appliedEntries: 1,
      lastReceivedSeq: 1,
    });
    expect(getSyncCursor(executor(adapter), 'remote-a')?.lastReceivedSeq).toBe(1);
    expect(adapter.loadAttempt('attempt-1')).toMatchObject({
      id: 'attempt-1',
      nodeId: 'task-1',
      status: 'running',
    });
    expect(remoteExec).toHaveBeenCalledWith(expect.objectContaining({
      sshArgs: expect.arrayContaining(['-i', '/dev/null', '-p', '22']),
      phase: 'ssh_sync_pull',
    }));
  });

  it('does not advance the receive cursor on transport failure', async () => {
    const remoteExec = vi.fn(async () => {
      throw new Error('network down');
    });

    await expect(channel(remoteExec).pull()).rejects.toThrow('network down');

    expect(getSyncCursor(executor(adapter), 'remote-a')).toBeUndefined();
  });

  it('treats duplicate pull delivery as idempotent', async () => {
    const lines = [
      remoteLine(1, 'attempt_started', T1),
      remoteLine(2, 'output', T2, { offset: 0, dataB64: b64('hello\n') }),
    ];
    const remoteExec = fakePullExec(() => lines, { ignoreSince: true });
    const sync = channel(remoteExec);

    await sync.pull();
    const second = await sync.pull();

    expect(second).toMatchObject({
      sinceSeq: 2,
      highWaterSeq: 2,
      receivedEntries: 0,
      appliedEntries: 0,
    });
    expect(importedEntries(adapter)).toHaveLength(2);
    expect(outputRows(adapter)).toEqual([{ task_id: 'task-1', offset: 0, data: 'hello\n' }]);
  });

  it('resumes from persisted cursors and applies exactly the missed entries after reconnect', async () => {
    const journal: string[] = [
      remoteLine(1, 'attempt_started', T1),
    ];
    const firstExec = fakePullExec(() => journal);
    await channel(firstExec).pull();

    journal.push(
      remoteLine(2, 'heartbeat', T2),
      remoteLine(3, 'attempt_finished', T3, { status: 'completed', exitCode: 0 }),
    );
    const reconnectExec = fakePullExec(() => journal);
    const result = await channel(reconnectExec).pull();

    expect(result).toMatchObject({
      sinceSeq: 1,
      highWaterSeq: 3,
      receivedEntries: 2,
      appliedEntries: 2,
      lastReceivedSeq: 3,
    });
    expect(importedEntries(adapter).map((entry) => entry.seq)).toHaveLength(3);
    expect(adapter.loadAttempt('attempt-1')?.status).toBe('completed');
    expect(getSyncCursor(executor(adapter), 'remote-a')).toMatchObject({
      lastReceivedSeq: 3,
    });
  });
});

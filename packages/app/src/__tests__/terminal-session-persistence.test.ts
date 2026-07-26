import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { IpcMain } from 'electron';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import {
  closeTaskTerminalSession,
  listTaskTerminalSessions,
  registerTerminalSessionIpcHandlers,
  registerTerminalSessionPersistence,
  restorePersistedTerminalSessions,
} from '../terminal-session-ipc.js';
import type { SQLiteAdapter, TerminalSessionRecord } from '@invoker/data-store';
import type { TaskState } from '@invoker/workflow-core';
import {
  createTerminalUiPerfCounters,
  createTerminalUiPerfReporter,
  createTerminalUiPerfSink,
} from '../terminal-ui-perf.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: Mock };
  killed: boolean;
  kill: Mock;
}

function createFakeChild(): FakeChild {
  const ee = new EventEmitter() as FakeChild;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdin = { write: vi.fn() };
  ee.killed = false;
  ee.kill = vi.fn();
  return ee;
}

function makeTerminalRow(
  sessionId: string,
  taskId: string,
  overrides: Partial<TerminalSessionRecord> = {},
): TerminalSessionRecord {
  return {
    sessionId,
    taskId,
    targetKey: `target:${sessionId}`,
    status: 'running',
    exitCode: undefined,
    cwd: `/tmp/${taskId}`,
    command: undefined,
    args: [],
    linuxTerminalTail: undefined,
    mode: 'spawn',
    attached: false,
    outputSnapshot: '',
    createdAt: '2026-07-26T00:00:00.000Z',
    updatedAt: '2026-07-26T00:00:00.000Z',
    ...overrides,
  };
}
describe('registerTerminalSessionPersistence coalesce', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(coalesceMs = 250) {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const upserts: Array<{ status: string; outputSnapshot: string }> = [];
    const persistence = {
      listTerminalSessions: () => [],
      loadTask: () => ({ id: 'task-1' }),
      deleteTerminalSession: vi.fn(),
      updateTerminalSession: vi.fn(),
      upsertTerminalSession: vi.fn((record: { status: string; outputSnapshot: string }) => {
        upserts.push({ status: record.status, outputSnapshot: record.outputSnapshot });
      }),
    };
    const handle = registerTerminalSessionPersistence({
      embeddedTerminalManager: mgr,
      persistence: persistence as Pick<
        SQLiteAdapter,
        'upsertTerminalSession' | 'listTerminalSessions' | 'loadTask' | 'deleteTerminalSession' | 'updateTerminalSession'
      >,
      uiPerfStats: createTerminalUiPerfCounters(),
      terminalUiPerf: createTerminalUiPerfReporter({ throttleMs: 0 }),
      terminalUiPerfSink: createTerminalUiPerfSink(() => {}, createTerminalUiPerfCounters()),
      coalesceMs,
    });
    return { child, mgr, upserts, persistence, handle };
  }

  it('coalesces N running output chunks into one delayed upsert', () => {
    const { child, mgr, upserts, handle } = setup(250);
    mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    expect(upserts).toHaveLength(1);
    expect(upserts[0]).toMatchObject({ status: 'running', outputSnapshot: '' });

    const CHUNKS = 100;
    for (let i = 0; i < CHUNKS; i++) {
      child.stdout.emit('data', Buffer.from('x'));
    }
    expect(upserts).toHaveLength(1);

    vi.advanceTimersByTime(249);
    expect(upserts).toHaveLength(1);

    vi.advanceTimersByTime(1);
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toMatchObject({
      status: 'running',
      outputSnapshot: 'x'.repeat(CHUNKS),
    });

    handle.dispose();
  });

  it('exit flushes immediately with full snapshot and cancels pending timer', () => {
    const { child, mgr, upserts, handle } = setup(250);
    mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('hello'));
    expect(upserts).toHaveLength(1);

    child.emit('exit', 0);
    expect(upserts).toHaveLength(2);
    expect(upserts[1]).toMatchObject({
      status: 'exited',
      outputSnapshot: 'hello',
    });

    vi.advanceTimersByTime(1000);
    expect(upserts).toHaveLength(2);

    handle.dispose();
  });

  it('keeps only the latest snapshot across a coalesce window', () => {
    const { child, mgr, upserts, handle } = setup(100);
    mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });
    child.stdout.emit('data', Buffer.from('a'));
    child.stdout.emit('data', Buffer.from('b'));
    child.stdout.emit('data', Buffer.from('c'));
    vi.advanceTimersByTime(100);
    expect(upserts).toHaveLength(2);
    expect(upserts[1]?.outputSnapshot).toBe('abc');
    handle.dispose();
  });

  it('does not persist planning terminal sessions as task terminal records', () => {
    const { mgr, upserts, handle } = setup(100);

    mgr.openOrReuse({
      kind: 'planning',
      taskId: 'planning:plan-1',
      planningSessionId: 'plan-1',
      spec: { cwd: '/repo' },
      cwd: '/repo',
    });

    expect(upserts).toHaveLength(0);
    handle.dispose();
  });

  it('keeps task terminal IPC routes isolated from planning sessions', async () => {
    const { mgr, persistence, handle } = setup(100);
    type IpcHandler = (...args: unknown[]) => Promise<unknown>;
    const handlers = new Map<string, IpcHandler>();
    const ipcMain = {
      handle(channel: string, callback: IpcHandler) {
        handlers.set(channel, callback);
      },
    };
    registerTerminalSessionIpcHandlers({
      ipcMain: ipcMain as unknown as IpcMain,
      embeddedTerminalManager: mgr,
      persistence: persistence as unknown as Pick<SQLiteAdapter, 'listTerminalSessions' | 'deleteTerminalSession'>,
      uiPerfStats: createTerminalUiPerfCounters(),
      terminalUiPerf: createTerminalUiPerfReporter({ throttleMs: 0 }),
      terminalUiPerfSink: createTerminalUiPerfSink(() => {}, createTerminalUiPerfCounters()),
    });

    const planningSession = mgr.openOrReuse({
      kind: 'planning',
      taskId: 'planning:plan-1',
      planningSessionId: 'plan-1',
      spec: { cwd: '/repo' },
      cwd: '/repo',
    });
    const taskSession = mgr.openOrReuse({ taskId: 'task-1', spec: {}, cwd: '/tmp' });

    await expect(handlers.get('invoker:terminal-list')?.({})).resolves.toEqual([
      expect.objectContaining({ sessionId: taskSession.sessionId, kind: 'task' }),
    ]);
    await expect(
      handlers.get('invoker:terminal-write')?.({}, planningSession.sessionId, 'x'),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('planning terminal session'),
    });
    await expect(
      handlers.get('invoker:terminal-resize')?.({}, planningSession.sessionId, 80, 24),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('planning terminal session'),
    });
    await expect(
      handlers.get('invoker:terminal-close')?.({}, planningSession.sessionId),
    ).resolves.toEqual({
      ok: false,
      reason: expect.stringContaining('planning terminal session'),
    });

    handle.dispose();
  });
  it('falls back to live task sessions when persisted terminal rows fail to load', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const liveTask = mgr.openOrReuse({ taskId: 'task-live', spec: {}, cwd: '/tmp/task-live' });

    const sessions = listTaskTerminalSessions({
      embeddedTerminalManager: mgr,
      persistence: {
        listTerminalSessions: () => {
          throw new Error('db read failed');
        },
      },
    });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: liveTask.sessionId,
        taskId: 'task-live',
        kind: 'task',
      }),
    ]);
  });
  it('closes live task sessions even when persistence is unavailable', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const session = mgr.openOrReuse({ taskId: 'task-live', spec: {}, cwd: '/tmp/task-live' });

    const result = closeTaskTerminalSession({
      embeddedTerminalManager: mgr,
    }, session.sessionId);

    expect(result).toEqual({ ok: true });
    expect(mgr.get(session.sessionId)).toBeUndefined();
  });
  it('merges persisted task sessions with live task sessions and filters planning sessions', () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const liveTask = mgr.openOrReuse({ taskId: 'task-live', spec: {}, cwd: '/tmp/task-live' });
    mgr.openOrReuse({
      kind: 'planning',
      taskId: 'planning:plan-1',
      planningSessionId: 'plan-1',
      spec: { cwd: '/repo' },
      cwd: '/repo',
    });

    const taskPersistence: Pick<SQLiteAdapter, 'listTerminalSessions'> = {
      listTerminalSessions: () => [
        makeTerminalRow(liveTask.sessionId, 'task-live', {
          outputSnapshot: 'persisted-snapshot',
        }),
        makeTerminalRow('persisted-only', 'task-persisted', {
          outputSnapshot: 'persisted-only-output',
        }),
      ],
    };
    const sessions = listTaskTerminalSessions({
      embeddedTerminalManager: mgr,
      persistence: taskPersistence,
    });

    expect(sessions).toEqual([
      expect.objectContaining({
        sessionId: liveTask.sessionId,
        taskId: 'task-live',
        kind: 'task',
        outputSnapshot: liveTask.outputSnapshot,
      }),
      expect.objectContaining({
        sessionId: 'persisted-only',
        taskId: 'task-persisted',
        kind: 'task',
        outputSnapshot: 'persisted-only-output',
      }),
    ]);
  });

  it('restores running spawn sessions and expires attached sessions after owner restart', () => {
    const restoreSpawnSession = vi.fn();
    const updateTerminalSession = vi.fn();

    const embeddedTerminalManager: Pick<EmbeddedTerminalManager, 'restoreSpawnSession'> = {
      restoreSpawnSession,
    };
    const persistence: Pick<
      SQLiteAdapter,
      'listTerminalSessions' | 'loadTask' | 'deleteTerminalSession' | 'updateTerminalSession'
    > = {
      listTerminalSessions: () => [
        makeTerminalRow('spawn-running', 'task-spawn', {
          cwd: '/tmp/task-spawn',
          outputSnapshot: 'spawn-output',
          mode: 'spawn',
          attached: false,
        }),
        makeTerminalRow('attached-running', 'task-attached', {
          mode: 'attached',
          attached: true,
          outputSnapshot: 'attached-output',
        }),
      ],
      loadTask: () => ({ id: 'task' } as unknown as TaskState),
      deleteTerminalSession: vi.fn(),
      updateTerminalSession,
    };

    restorePersistedTerminalSessions({
      embeddedTerminalManager,
      persistence,
    });

    expect(restoreSpawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'spawn-running',
        taskId: 'task-spawn',
        cwd: '/tmp/task-spawn',
        outputSnapshot: 'spawn-output',
      }),
    );
    expect(updateTerminalSession).toHaveBeenCalledWith(
      'attached-running',
      expect.objectContaining({ status: 'exited' }),
    );
  });
});

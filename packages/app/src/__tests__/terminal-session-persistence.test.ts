import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import {
  registerTerminalSessionIpcHandlers,
  registerTerminalSessionPersistence,
} from '../terminal-session-ipc.js';
import {
  createTerminalUiPerfCounters,
  createTerminalUiPerfReporter,
  createTerminalUiPerfSink,
} from '../terminal-ui-perf.js';

function createFakeChild() {
  const ee = new EventEmitter() as any;
  ee.stdout = new EventEmitter();
  ee.stderr = new EventEmitter();
  ee.stdin = { write: vi.fn() };
  ee.killed = false;
  ee.kill = vi.fn();
  return ee;
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
      persistence: persistence as any,
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
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const ipcMain = {
      handle: vi.fn((channel: string, callback: (...args: any[]) => Promise<any>) => {
        handlers.set(channel, callback);
      }),
    };
    registerTerminalSessionIpcHandlers({
      ipcMain: ipcMain as any,
      embeddedTerminalManager: mgr,
      persistence: persistence as any,
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
});

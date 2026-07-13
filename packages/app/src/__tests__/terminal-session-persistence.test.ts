import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import {
  registerPlanningTerminalSessionIpcHandlers,
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
    const upserts: Array<any> = [];
    const persistence = {
      listTerminalSessions: () => [],
      loadTask: () => ({ id: 'task-1' }),
      loadInAppPlanningSession: () => ({ id: 'plan-1' }),
      deleteTerminalSession: vi.fn(),
      updateTerminalSession: vi.fn(),
      upsertTerminalSession: vi.fn((record: any) => {
        upserts.push(record);
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

  it('persists planning terminal sessions as planning terminal records', () => {
    const { mgr, upserts, handle } = setup(100);

    mgr.openOrReuse({
      kind: 'planning',
      taskId: 'planning:plan-1',
      planningSessionId: 'plan-1',
      spec: { cwd: '/repo' },
      cwd: '/repo',
    });

    expect(upserts).toEqual([
      expect.objectContaining({
        status: 'running',
        kind: 'planning',
        taskId: 'planning:plan-1',
        planningSessionId: 'plan-1',
      }),
    ]);
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

  it('keeps read-only planning terminal sessions non-editable', async () => {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const ipcMain = {
      handle: vi.fn((channel: string, callback: (...args: any[]) => Promise<any>) => {
        handlers.set(channel, callback);
      }),
    };
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: ipcMain as any,
      embeddedTerminalManager: mgr,
      logger: { info: vi.fn(), warn: vi.fn() },
      repoRoot: '/repo',
      isPlanningSessionReadOnly: (planningSessionId) => planningSessionId === 'plan-1',
    });

    await expect(
      handlers.get('invoker:planning-terminal-open')?.({}, 'plan-1'),
    ).resolves.toEqual({
      opened: false,
      reason: 'This planning session is read-only.',
    });

    const existing = mgr.openOrReuse({
      kind: 'planning',
      taskId: 'planning:plan-1',
      planningSessionId: 'plan-1',
      spec: { cwd: '/repo' },
      cwd: '/repo',
    });

    await expect(
      handlers.get('invoker:planning-terminal-open')?.({}, 'plan-1'),
    ).resolves.toEqual({
      opened: true,
      session: expect.objectContaining({
        sessionId: existing.sessionId,
        kind: 'planning',
        planningSessionId: 'plan-1',
      }),
    });
    await expect(
      handlers.get('invoker:planning-terminal-write')?.({}, existing.sessionId, 'x'),
    ).resolves.toEqual({
      ok: false,
      reason: 'This planning session is read-only.',
    });
    expect(child.stdin.write).not.toHaveBeenCalled();
  });
});

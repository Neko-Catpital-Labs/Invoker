import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import type { IpcMain } from 'electron';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  MAX_OUTPUT_SNAPSHOT_CHARS,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import {
  bindPlanningTerminalSessionState,
  closeTaskTerminalSession,
  listTaskTerminalSessions,
  registerPlanningTerminalSessionIpcHandlers,
  registerTerminalSessionIpcHandlers,
  registerTerminalSessionPersistence,
  restorePersistedTerminalSessions,
} from '../terminal-session-ipc.js';
import {
  PLANNING_TERMINAL_SUMMARY_BRIDGE_START,
  buildPlanningTerminalSummaryBridge,
  createInAppPlanningChatSessions,
  type InAppPlanningChatSession,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';
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

function makePlanningSession(
  id = 'plan-1',
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
  return {
    id,
    title: 'Planning terminal bridge',
    presetKey: 'codex',
    confirmationMode: 'require',
    status: 'draft_ready',
    messages: [
      { id: 1, role: 'user', text: 'Add README', createdAt: '2026-07-07T00:00:00.000Z' },
      { id: 2, role: 'assistant', text: 'I drafted the restart plan.', createdAt: '2026-07-07T00:00:01.000Z' },
    ],
    conversation: {} as InAppPlanningChatSession['conversation'],
    draftPlanSummary: {
      name: 'Planning Terminal Restart',
      taskCount: 1,
      steps: ['Update README'],
      taskGroups: [],
    },
    terminalMode: 'chat',
    terminalOutputSnapshot: '',
    createdAt: '2026-07-07T00:00:00.000Z',
    updatedAt: '2026-07-07T00:00:01.000Z',
    nextMessageId: 3,
    ...overrides,
  };
}

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
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

  it('restores persisted planning terminal sessions with saved output snapshots', () => {
    const sessions = createInAppPlanningChatSessions();
    sessions.set('plan-restore', makePlanningSession('plan-restore', {
      terminalMode: 'tmux',
      terminalSessionId: 'term-plan-restore',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'saved planning tmux output\n',
      terminalUpdatedAt: '2026-07-26T00:00:03.000Z',
    }));
    const restoreSpawnSession = vi.fn();
    const embeddedTerminalManager = Object.assign(new EventEmitter(), {
      restoreSpawnSession,
    }) as unknown as EmbeddedTerminalManager;

    const { restorePersistedPlanningTerminals } = bindPlanningTerminalSessionState({
      embeddedTerminalManager,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    restorePersistedPlanningTerminals();

    expect(restoreSpawnSession).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'term-plan-restore',
      taskId: 'planning:plan-restore',
      kind: 'planning',
      planningSessionId: 'plan-restore',
      cwd: '/repo',
      outputSnapshot: expect.stringContaining('saved planning tmux output\n'),
    }));
    const [restoredArgs] = restoreSpawnSession.mock.calls[0];
    expect(restoredArgs.outputSnapshot).toContain(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
  });

  it('planning terminal open persists the returned session snapshot onto the planning chat', async () => {
    type IpcHandler = (...args: unknown[]) => Promise<unknown>;
    const handlers = new Map<string, IpcHandler>();
    const sessions = createInAppPlanningChatSessions();
    sessions.set('plan-open', makePlanningSession('plan-open'));
    const openedSession = {
      sessionId: 'term-plan-open',
      taskId: 'planning:plan-open',
      kind: 'planning' as const,
      planningSessionId: 'plan-open',
      status: 'running' as const,
      cwd: '/repo',
      mode: 'spawn' as const,
      attached: false,
      createdAt: '2026-07-26T00:00:00.000Z',
      outputSnapshot: 'shell restored from open\n',
    };
    const embeddedTerminalManager = Object.assign(new EventEmitter(), {
      openOrReuse: vi.fn(() => openedSession),
    }) as unknown as EmbeddedTerminalManager;
    const ipcMain = {
      handle(channel: string, callback: IpcHandler) {
        handlers.set(channel, callback);
      },
    };

    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: ipcMain as unknown as IpcMain,
      embeddedTerminalManager,
      logger: { info: vi.fn(), warn: vi.fn() },
      planningChatSessions: sessions,
      getPlanningSessionStore: () => undefined,
      repoRoot: '/repo',
    });

    await expect(handlers.get('invoker:planning-terminal-open')?.({}, 'plan-open')).resolves.toEqual({
      opened: true,
      session: openedSession,
    });
    expect(sessions.get('plan-open')).toMatchObject({
      terminalMode: 'tmux',
      terminalSessionId: 'term-plan-open',
      terminalStatus: 'running',
      terminalOutputSnapshot: 'shell restored from open\n',
    });
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

describe('planning terminal summary bridge persistence', () => {
  function setupPlanningTerminal() {
    const child = createFakeChild();
    const mgr = new EmbeddedTerminalManager({
      backend: createBashTerminalBackend({ spawnFn: (() => child) as unknown as BashSpawnFn }),
    });
    const planningChatSessions = createInAppPlanningChatSessions();
    const updateInAppPlanningSession = vi.fn();
    const planningSessionStore: InAppPlanningSessionStore = {
      upsertInAppPlanningSession: vi.fn(),
      updateInAppPlanningSession,
      deleteInAppPlanningSession: vi.fn(),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const handlers = new Map<string, (...args: any[]) => Promise<any>>();
    const ipcMain = {
      handle: vi.fn((channel: string, callback: (...args: any[]) => Promise<any>) => {
        handlers.set(channel, callback);
      }),
    };

    const planningTerminalState = bindPlanningTerminalSessionState({
      embeddedTerminalManager: mgr,
      logger,
      planningChatSessions,
      getPlanningSessionStore: () => planningSessionStore,
      repoRoot: '/repo',
    });
    registerPlanningTerminalSessionIpcHandlers({
      ipcMain: ipcMain as any,
      embeddedTerminalManager: mgr,
      logger,
      planningChatSessions,
      getPlanningSessionStore: () => planningSessionStore,
      repoRoot: '/repo',
    });

    return {
      child,
      handlers,
      mgr,
      planningChatSessions,
      planningSessionStore,
      restorePersistedPlanningTerminals: planningTerminalState.restorePersistedPlanningTerminals,
      updateInAppPlanningSession,
    };
  }

  it('planningTerminalOpen seeds bridge text into the planning terminal output snapshot', async () => {
    const {
      child,
      handlers,
      planningChatSessions,
      updateInAppPlanningSession,
    } = setupPlanningTerminal();
    const planningSession = makePlanningSession();
    planningChatSessions.set(planningSession.id, planningSession);

    const result = await handlers.get('invoker:planning-terminal-open')?.({}, planningSession.id);

    expect(result).toMatchObject({
      opened: true,
      session: expect.objectContaining({
        kind: 'planning',
        planningSessionId: planningSession.id,
        outputSnapshot: expect.stringContaining(PLANNING_TERMINAL_SUMMARY_BRIDGE_START),
      }),
    });
    expect(result.session.outputSnapshot).toContain('Planning session: Planning terminal bridge');
    expect(result.session.outputSnapshot).toContain('Draft plan: Planning Terminal Restart (1 task) - Update README');
    expect(planningChatSessions.get(planningSession.id)?.terminalOutputSnapshot).toBe(result.session.outputSnapshot);
    expect(updateInAppPlanningSession).toHaveBeenCalledWith(
      planningSession.id,
      expect.objectContaining({
        terminalMode: 'tmux',
        terminalSessionId: result.session.sessionId,
        terminalOutputSnapshot: result.session.outputSnapshot,
      }),
    );
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('restores a tmux planning session with one bridge copy and previous output', () => {
    const {
      child,
      mgr,
      planningChatSessions,
      restorePersistedPlanningTerminals,
    } = setupPlanningTerminal();
    const previousOutput = 'previous terminal output\n';
    const planningSession = makePlanningSession('plan-restored', {
      terminalMode: 'tmux',
      terminalSessionId: 'term-planning-restored',
      terminalStatus: 'running',
      terminalOutputSnapshot: previousOutput,
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
    });
    planningChatSessions.set(planningSession.id, planningSession);

    restorePersistedPlanningTerminals();
    restorePersistedPlanningTerminals();

    const restoredSnapshot = mgr.get('term-planning-restored')?.outputSnapshot ?? '';
    expect(restoredSnapshot).toContain(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
    expect(restoredSnapshot).toContain(previousOutput);
    expect(countOccurrences(restoredSnapshot, PLANNING_TERMINAL_SUMMARY_BRIDGE_START)).toBe(1);
    expect(planningChatSessions.get(planningSession.id)?.terminalOutputSnapshot).toBe(restoredSnapshot);
    expect(child.stdin.write).not.toHaveBeenCalled();
  });

  it('does not duplicate a bridge that is already in the restored snapshot', () => {
    const { mgr, planningChatSessions, restorePersistedPlanningTerminals } = setupPlanningTerminal();
    const seedSession = makePlanningSession('plan-bridged', { title: 'Stale title' });
    const alreadyBridgedSnapshot = `${buildPlanningTerminalSummaryBridge(seedSession)}previous terminal output\n`;
    planningChatSessions.set(seedSession.id, {
      ...seedSession,
      title: 'Fresh title',
      terminalMode: 'tmux',
      terminalSessionId: 'term-planning-bridged',
      terminalStatus: 'running',
      terminalOutputSnapshot: alreadyBridgedSnapshot,
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
    });

    restorePersistedPlanningTerminals();

    const restoredSnapshot = mgr.get('term-planning-bridged')?.outputSnapshot ?? '';
    expect(restoredSnapshot).toContain('Planning session: Fresh title');
    expect(restoredSnapshot).not.toContain('Planning session: Stale title');
    expect(restoredSnapshot).toContain('previous terminal output\n');
    expect(countOccurrences(restoredSnapshot, PLANNING_TERMINAL_SUMMARY_BRIDGE_START)).toBe(1);
  });

  it('keeps the fresh bridge intact when restoring a near-cap persisted snapshot', () => {
    const { mgr, planningChatSessions, restorePersistedPlanningTerminals } = setupPlanningTerminal();
    const previousOutput = 'x'.repeat(MAX_OUTPUT_SNAPSHOT_CHARS);
    const planningSession = makePlanningSession('plan-near-cap', {
      terminalMode: 'tmux',
      terminalSessionId: 'term-planning-near-cap',
      terminalStatus: 'running',
      terminalOutputSnapshot: previousOutput,
      terminalUpdatedAt: '2026-07-07T00:00:02.000Z',
    });
    planningChatSessions.set(planningSession.id, planningSession);

    restorePersistedPlanningTerminals();

    const restoredSnapshot = mgr.get('term-planning-near-cap')?.outputSnapshot ?? '';
    expect(restoredSnapshot.length).toBeLessThanOrEqual(MAX_OUTPUT_SNAPSHOT_CHARS);
    expect(restoredSnapshot).toContain(PLANNING_TERMINAL_SUMMARY_BRIDGE_START);
    expect(restoredSnapshot).toContain('Planning session: Planning terminal bridge');
  });
});

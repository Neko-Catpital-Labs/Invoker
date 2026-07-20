import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  EmbeddedTerminalManager,
  createBashTerminalBackend,
  type BashSpawnFn,
} from '../embedded-terminal-manager.js';
import {
  PLANNING_TERMINAL_SUMMARY_BRIDGE_START,
  buildPlanningTerminalSummaryBridge,
  createInAppPlanningChatSessions,
  type InAppPlanningChatSession,
  type InAppPlanningSessionStore,
} from '../in-app-planner.js';
import {
  bindPlanningTerminalSessionState,
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

function makePlanningSession(
  overrides: Partial<InAppPlanningChatSession> = {},
): InAppPlanningChatSession {
  return {
    id: 'plan-1',
    title: 'Planning terminal bridge',
    presetKey: 'codex',
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
    const planningSession = makePlanningSession({
      id: 'plan-restored',
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
    const seedSession = makePlanningSession({ id: 'plan-bridged', title: 'Stale title' });
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
});

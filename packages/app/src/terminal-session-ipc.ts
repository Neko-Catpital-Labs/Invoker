import type { IpcMain } from 'electron';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { EmbeddedTerminalManager, TerminalSessionPersistenceRecord } from './embedded-terminal-manager.js';
import {
  timeTerminalResize,
  timeTerminalSessionUpsert,
  timeTerminalWrite,
  type TerminalUiPerfCounters,
  type TerminalUiPerfReporter,
  type TerminalUiPerfSink,
} from './terminal-ui-perf.js';
import {
  updatePlanningChatTerminalState,
  type InAppPlanningChatSessions,
  type InAppPlanningSessionStore,
} from './in-app-planner.js';

/** Coalesce running-session snapshot upserts so PTY output does not 1:1 SQLite-write on main. */
export const TERMINAL_SESSION_UPSERT_COALESCE_MS = 250;

type TerminalSessionRow = ReturnType<SQLiteAdapter['listTerminalSessions']>[number];
type PlanningSessionStoreGetter = () => InAppPlanningSessionStore | undefined;

interface PlanningTerminalLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export function terminalRowToDescriptor(row: TerminalSessionRow): TerminalSessionDescriptor {
  return {
    sessionId: row.sessionId,
    taskId: row.taskId,
    kind: 'task',
    status: row.status,
    exitCode: row.exitCode,
    cwd: row.cwd,
    command: row.command,
    args: row.args,
    mode: row.mode,
    attached: row.attached,
    createdAt: row.createdAt,
    outputSnapshot: row.outputSnapshot,
  };
}

export function restorePersistedTerminalSessions(deps: {
  persistence: Pick<SQLiteAdapter, 'listTerminalSessions' | 'loadTask' | 'deleteTerminalSession' | 'updateTerminalSession'>;
  embeddedTerminalManager: Pick<EmbeddedTerminalManager, 'restoreSpawnSession'>;
}): void {
  const nowIso = () => new Date().toISOString();
  for (const row of deps.persistence.listTerminalSessions()) {
    if (!deps.persistence.loadTask(row.taskId)) {
      deps.persistence.deleteTerminalSession(row.sessionId);
      continue;
    }
    if (row.status !== 'running') continue;
    if (row.mode === 'attached') {
      deps.persistence.updateTerminalSession(row.sessionId, { status: 'exited', updatedAt: nowIso() });
      continue;
    }
    try {
      deps.embeddedTerminalManager.restoreSpawnSession({
        sessionId: row.sessionId,
        taskId: row.taskId,
        targetKey: row.targetKey,
        spec: {
          cwd: row.cwd,
          command: row.command,
          args: row.args,
          linuxTerminalTail: row.linuxTerminalTail,
        },
        cwd: row.cwd ?? process.cwd(),
        createdAt: row.createdAt,
        outputSnapshot: row.outputSnapshot,
      });
    } catch {
      deps.persistence.updateTerminalSession(row.sessionId, { status: 'exited', updatedAt: nowIso() });
    }
  }
}

function toUpsertRow(record: TerminalSessionPersistenceRecord) {
  return {
    sessionId: record.sessionId,
    taskId: record.taskId,
    targetKey: record.targetKey,
    status: record.status,
    exitCode: record.exitCode,
    cwd: record.cwd,
    command: record.spec.command,
    args: record.spec.args,
    linuxTerminalTail: record.spec.linuxTerminalTail,
    mode: record.mode,
    attached: record.attached,
    outputSnapshot: record.outputSnapshot,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export interface TerminalSessionPersistenceHandle {
  /** Flush any coalesced running-session upserts immediately. */
  flushPending: () => void;
  /** Remove the session-updated listener and clear timers. */
  dispose: () => void;
}

export function registerTerminalSessionPersistence(deps: {
  embeddedTerminalManager: EmbeddedTerminalManager;
  persistence: Pick<SQLiteAdapter, 'upsertTerminalSession' | 'listTerminalSessions' | 'loadTask' | 'deleteTerminalSession' | 'updateTerminalSession'>;
  uiPerfStats: TerminalUiPerfCounters;
  terminalUiPerf: TerminalUiPerfReporter;
  terminalUiPerfSink: TerminalUiPerfSink;
  /** Override coalesce window (tests). */
  coalesceMs?: number;
}): TerminalSessionPersistenceHandle {
  const coalesceMs = deps.coalesceMs ?? TERMINAL_SESSION_UPSERT_COALESCE_MS;
  const pendingBySession = new Map<string, TerminalSessionPersistenceRecord>();
  const timerBySession = new Map<string, ReturnType<typeof setTimeout>>();

  const upsertNow = (record: TerminalSessionPersistenceRecord): void => {
    timeTerminalSessionUpsert(
      () => {
        deps.persistence.upsertTerminalSession(toUpsertRow(record));
      },
      deps.uiPerfStats,
      deps.terminalUiPerf,
      deps.terminalUiPerfSink,
      {
        sessionId: record.sessionId,
        taskId: record.taskId,
        status: record.status,
        outputSnapshotChars: record.outputSnapshot?.length ?? 0,
      },
    );
  };

  const clearTimer = (sessionId: string): void => {
    const timer = timerBySession.get(sessionId);
    if (timer !== undefined) {
      clearTimeout(timer);
      timerBySession.delete(sessionId);
    }
  };

  const flushSession = (sessionId: string): void => {
    clearTimer(sessionId);
    const pending = pendingBySession.get(sessionId);
    if (!pending) return;
    pendingBySession.delete(sessionId);
    upsertNow(pending);
  };

  const flushPending = (): void => {
    for (const sessionId of [...pendingBySession.keys()]) {
      flushSession(sessionId);
    }
  };

  const scheduleCoalesced = (record: TerminalSessionPersistenceRecord): void => {
    pendingBySession.set(record.sessionId, record);
    if (timerBySession.has(record.sessionId)) return;
    timerBySession.set(
      record.sessionId,
      setTimeout(() => {
        timerBySession.delete(record.sessionId);
        flushSession(record.sessionId);
      }, coalesceMs),
    );
  };

  const onSessionUpdated = (record: TerminalSessionPersistenceRecord): void => {
    if (record.kind !== 'task') return;

    // Open (empty snapshot) and exit/status boundaries persist immediately so
    // restart restore and final state stay correct. Output while running is
    // coalesced — that is the PTY storm path that blocked Electron main.
    const isLifecycleBoundary =
      record.status !== 'running' || record.outputSnapshot.length === 0;

    if (isLifecycleBoundary) {
      clearTimer(record.sessionId);
      pendingBySession.delete(record.sessionId);
      upsertNow(record);
      return;
    }

    scheduleCoalesced(record);
  };

  deps.embeddedTerminalManager.on('session-updated', onSessionUpdated);
  restorePersistedTerminalSessions(deps);

  return {
    flushPending,
    dispose: () => {
      flushPending();
      deps.embeddedTerminalManager.off('session-updated', onSessionUpdated);
      for (const timer of timerBySession.values()) clearTimeout(timer);
      timerBySession.clear();
      pendingBySession.clear();
    },
  };
}

export function registerTerminalSessionIpcHandlers(deps: {
  ipcMain: IpcMain;
  embeddedTerminalManager: EmbeddedTerminalManager;
  persistence: Pick<SQLiteAdapter, 'listTerminalSessions' | 'deleteTerminalSession'>;
  uiPerfStats: TerminalUiPerfCounters;
  terminalUiPerf: TerminalUiPerfReporter;
  terminalUiPerfSink: TerminalUiPerfSink;
}): void {
  const { ipcMain, embeddedTerminalManager, persistence, uiPerfStats, terminalUiPerf, terminalUiPerfSink } = deps;

  ipcMain.handle('invoker:terminal-list', async () => {
    const liveSessions = embeddedTerminalManager
      .list()
      .filter((session) => session.kind !== 'planning');
    const live = new Map(liveSessions.map((session) => [session.sessionId, session]));
    const merged = persistence.listTerminalSessions().map((row) => live.get(row.sessionId) ?? terminalRowToDescriptor(row));
    const persistedIds = new Set(merged.map((session) => session.sessionId));
    for (const session of live.values()) {
      if (!persistedIds.has(session.sessionId)) {
        merged.push(session);
      }
    }
    return merged;
  });

  ipcMain.handle('invoker:terminal-write', async (_event, sessionId: string, data: string) => {
    const session = embeddedTerminalManager.get(sessionId);
    if (session?.kind === 'planning') {
      return { ok: false, reason: `Session "${sessionId}" is a planning terminal session.` };
    }
    return timeTerminalWrite(
      () => embeddedTerminalManager.write(sessionId, data),
      uiPerfStats,
      terminalUiPerf,
      terminalUiPerfSink,
      {
        sessionId,
        bytes: typeof data === 'string' ? data.length : 0,
      },
    );
  });

  ipcMain.handle('invoker:terminal-resize', async (_event, sessionId: string, cols: number, rows: number) => {
    const session = embeddedTerminalManager.get(sessionId);
    if (session?.kind === 'planning') {
      return { ok: false, reason: `Session "${sessionId}" is a planning terminal session.` };
    }
    return timeTerminalResize(
      () => embeddedTerminalManager.resize(sessionId, cols, rows),
      uiPerfStats,
      terminalUiPerf,
      terminalUiPerfSink,
      {
        sessionId,
        cols,
        rows,
      },
    );
  });

  ipcMain.handle('invoker:terminal-close', async (_event, sessionId: string) => {
    const session = embeddedTerminalManager.get(sessionId);
    if (session?.kind === 'planning') {
      return { ok: false, reason: `Session "${sessionId}" is a planning terminal session.` };
    }
    const result = embeddedTerminalManager.close(sessionId);
    persistence.deleteTerminalSession(sessionId);
    return result.ok ? result : { ok: true };
  });
}

function planningTerminalOnly(
  embeddedTerminalManager: EmbeddedTerminalManager,
  planningChatSessions: InAppPlanningChatSessions,
  sessionId: string,
): { ok: true; planningSessionId: string } | { ok: false; reason: string } {
  const session = embeddedTerminalManager.get(sessionId);
  if (!session) return { ok: false, reason: `Unknown session "${sessionId}".` };
  if (session.kind !== 'planning') {
    return { ok: false, reason: `Session "${sessionId}" is not a planning terminal session.` };
  }
  const planningSessionId = session.planningSessionId ?? '';
  if (!planningSessionId || !planningChatSessions.has(planningSessionId)) {
    return { ok: false, reason: `Session "${sessionId}" is not owned by a planning conversation.` };
  }
  return { ok: true, planningSessionId };
}

function planningTerminalWritable(
  embeddedTerminalManager: EmbeddedTerminalManager,
  planningChatSessions: InAppPlanningChatSessions,
  getPlanningSessionStore: PlanningSessionStoreGetter,
  sessionId: string,
): { ok: true } | { ok: false; reason: string } {
  const allowed = planningTerminalOnly(embeddedTerminalManager, planningChatSessions, sessionId);
  if (!allowed.ok) return allowed;
  if (!getPlanningSessionStore()) {
    return { ok: false, reason: 'Planning terminal is read-only in this window.' };
  }
  const planningSession = planningChatSessions.get(allowed.planningSessionId);
  if (planningSession?.status === 'submitted') {
    return { ok: false, reason: 'This planning session was already submitted.' };
  }
  return { ok: true };
}

function planningTerminalTargetKey(planningSessionId: string, repoRoot: string): string {
  return JSON.stringify({
    kind: 'planning',
    planningSessionId,
    taskId: `planning:${planningSessionId}`,
    cwd: repoRoot,
    command: null,
    args: [],
    linuxTerminalTail: null,
    attach: null,
  });
}

export function bindPlanningTerminalSessionState(deps: {
  embeddedTerminalManager: EmbeddedTerminalManager;
  logger: PlanningTerminalLogger;
  planningChatSessions: InAppPlanningChatSessions;
  getPlanningSessionStore: PlanningSessionStoreGetter;
  repoRoot: string;
}): { restorePersistedPlanningTerminals: () => void } {
  const {
    embeddedTerminalManager,
    logger,
    planningChatSessions,
    getPlanningSessionStore,
    repoRoot,
  } = deps;

  embeddedTerminalManager.on('session-updated', (record: TerminalSessionPersistenceRecord) => {
    if (record.kind !== 'planning' || !record.planningSessionId) return;
    updatePlanningChatTerminalState(record.planningSessionId, {
      terminalMode: 'tmux',
      terminalSessionId: record.sessionId,
      terminalStatus: record.status,
      terminalExitCode: record.exitCode,
      terminalOutputSnapshot: record.outputSnapshot,
      terminalUpdatedAt: record.updatedAt,
      touchSessionUpdatedAt: record.status !== 'running' || record.outputSnapshot.length === 0,
    }, {
      sessions: planningChatSessions,
      planningSessionStore: getPlanningSessionStore(),
    });
  });

  const restorePersistedPlanningTerminals = (): void => {
    for (const session of planningChatSessions.values()) {
      if (
        session.terminalMode !== 'tmux'
        || !session.terminalSessionId
        || session.terminalStatus === 'exited'
      ) {
        continue;
      }
      try {
        embeddedTerminalManager.restoreSpawnSession({
          sessionId: session.terminalSessionId,
          taskId: `planning:${session.id}`,
          kind: 'planning',
          planningSessionId: session.id,
          targetKey: planningTerminalTargetKey(session.id, repoRoot),
          spec: { cwd: repoRoot },
          cwd: repoRoot,
          createdAt: session.terminalUpdatedAt ?? session.updatedAt,
          outputSnapshot: session.terminalOutputSnapshot ?? '',
        });
      } catch (err) {
        logger.warn(
          `planning terminal restore failed for session="${session.id}": ${err instanceof Error ? err.message : String(err)}`,
          { module: 'planning-terminal' },
        );
        updatePlanningChatTerminalState(session.id, {
          terminalMode: 'tmux',
          terminalSessionId: session.terminalSessionId,
          terminalStatus: 'exited',
          terminalOutputSnapshot: session.terminalOutputSnapshot ?? '',
          touchSessionUpdatedAt: true,
        }, {
          sessions: planningChatSessions,
          planningSessionStore: getPlanningSessionStore(),
        });
      }
    }
  };

  return { restorePersistedPlanningTerminals };
}

export function registerPlanningTerminalSessionIpcHandlers(deps: {
  ipcMain: IpcMain;
  embeddedTerminalManager: EmbeddedTerminalManager;
  logger: PlanningTerminalLogger;
  planningChatSessions: InAppPlanningChatSessions;
  getPlanningSessionStore: PlanningSessionStoreGetter;
  repoRoot: string;
}): void {
  const {
    ipcMain,
    embeddedTerminalManager,
    logger,
    planningChatSessions,
    getPlanningSessionStore,
    repoRoot,
  } = deps;

  ipcMain.handle('invoker:planning-terminal-open', async (_event, planningSessionIdArg: string) => {
    const planningSessionId = String(planningSessionIdArg ?? '').trim();
    if (!planningSessionId) {
      return { opened: false, reason: 'Planning session id is required.' };
    }
    const planningSession = planningChatSessions.get(planningSessionId);
    if (!planningSession) {
      return { opened: false, reason: 'Planning conversation was not found.' };
    }
    if (planningSession.status === 'submitted') {
      return { opened: false, reason: 'This planning session was already submitted.' };
    }
    logger.info(`invoked for planningSession="${planningSessionId}"`, { module: 'planning-terminal' });
    try {
      const session = embeddedTerminalManager.openOrReuse({
        kind: 'planning',
        taskId: `planning:${planningSessionId}`,
        planningSessionId,
        spec: { cwd: repoRoot },
        cwd: repoRoot,
      });
      updatePlanningChatTerminalState(planningSessionId, {
        terminalMode: 'tmux',
        terminalSessionId: session.sessionId,
        terminalStatus: session.status,
        terminalExitCode: session.exitCode,
        terminalOutputSnapshot: session.outputSnapshot ?? '',
        touchSessionUpdatedAt: true,
      }, {
        sessions: planningChatSessions,
        planningSessionStore: getPlanningSessionStore(),
      });
      return { opened: true, session };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger.warn(`planning terminal spawn failed for session="${planningSessionId}": ${reason}`, { module: 'planning-terminal' });
      return { opened: false, reason: `Failed to start planning terminal session: ${reason}` };
    }
  });

  ipcMain.handle('invoker:planning-terminal-list', async () => {
    return embeddedTerminalManager.list().filter((session) => session.kind === 'planning');
  });

  ipcMain.handle('invoker:planning-terminal-write', async (_event, sessionId: string, data: string) => {
    const allowed = planningTerminalWritable(
      embeddedTerminalManager,
      planningChatSessions,
      getPlanningSessionStore,
      sessionId,
    );
    if (!allowed.ok) return allowed;
    return embeddedTerminalManager.write(sessionId, data);
  });

  ipcMain.handle('invoker:planning-terminal-resize', async (_event, sessionId: string, cols: number, rows: number) => {
    const allowed = planningTerminalOnly(embeddedTerminalManager, planningChatSessions, sessionId);
    if (!allowed.ok) return allowed;
    return embeddedTerminalManager.resize(sessionId, cols, rows);
  });

  ipcMain.handle('invoker:planning-terminal-close', async (_event, sessionId: string) => {
    const allowed = planningTerminalOnly(embeddedTerminalManager, planningChatSessions, sessionId);
    if (!allowed.ok) return allowed;
    return embeddedTerminalManager.close(sessionId);
  });
}

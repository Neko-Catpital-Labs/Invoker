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

/** Coalesce running-session snapshot upserts so PTY output does not 1:1 SQLite-write on main. */
export const TERMINAL_SESSION_UPSERT_COALESCE_MS = 250;

type TerminalSessionRow = ReturnType<SQLiteAdapter['listTerminalSessions']>[number];

interface PlanningTerminalLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
}

export function terminalRowToDescriptor(row: TerminalSessionRow): TerminalSessionDescriptor {
  return {
    sessionId: row.sessionId,
    taskId: row.taskId,
    kind: row.kind,
    planningSessionId: row.planningSessionId,
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
  persistence: Pick<SQLiteAdapter, 'listTerminalSessions' | 'loadTask' | 'loadInAppPlanningSession' | 'deleteTerminalSession' | 'updateTerminalSession'>;
  embeddedTerminalManager: Pick<EmbeddedTerminalManager, 'restoreSpawnSession'>;
}): void {
  const nowIso = () => new Date().toISOString();
  for (const row of deps.persistence.listTerminalSessions()) {
    if (row.kind === 'planning') {
      if (!row.planningSessionId || !deps.persistence.loadInAppPlanningSession(row.planningSessionId)) {
        deps.persistence.deleteTerminalSession(row.sessionId);
        continue;
      }
    } else if (!deps.persistence.loadTask(row.taskId)) {
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
        kind: row.kind,
        planningSessionId: row.planningSessionId,
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
    kind: record.kind,
    planningSessionId: record.planningSessionId,
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
  persistence: Pick<SQLiteAdapter, 'upsertTerminalSession' | 'listTerminalSessions' | 'loadTask' | 'loadInAppPlanningSession' | 'deleteTerminalSession' | 'updateTerminalSession'>;
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
    const merged = persistence
      .listTerminalSessions()
      .filter((row) => row.kind !== 'planning')
      .map((row) => live.get(row.sessionId) ?? terminalRowToDescriptor(row));
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
  sessionId: string,
): { ok: true } | { ok: false; reason: string } {
  const session = embeddedTerminalManager.get(sessionId);
  if (!session) return { ok: false, reason: `Unknown session "${sessionId}".` };
  if (session.kind !== 'planning') {
    return { ok: false, reason: `Session "${sessionId}" is not a planning terminal session.` };
  }
  return { ok: true };
}

export function registerPlanningTerminalSessionIpcHandlers(deps: {
  ipcMain: IpcMain;
  embeddedTerminalManager: EmbeddedTerminalManager;
  logger: PlanningTerminalLogger;
  repoRoot: string;
  isPlanningSessionReadOnly?: (planningSessionId: string) => boolean;
  onPlanningTerminalOpened?: (planningSessionId: string, terminalSessionId: string) => void;
}): void {
  const { ipcMain, embeddedTerminalManager, logger, repoRoot } = deps;

  ipcMain.handle('invoker:planning-terminal-open', async (_event, planningSessionIdArg: string) => {
    const planningSessionId = String(planningSessionIdArg ?? '').trim();
    if (!planningSessionId) {
      return { opened: false, reason: 'Planning session id is required.' };
    }
    if (deps.isPlanningSessionReadOnly?.(planningSessionId)) {
      const existing = embeddedTerminalManager
        .list()
        .find((session) => session.kind === 'planning' && session.planningSessionId === planningSessionId);
      if (existing) return { opened: true, session: existing };
      return { opened: false, reason: 'This planning session is read-only.' };
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
      deps.onPlanningTerminalOpened?.(planningSessionId, session.sessionId);
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
    const allowed = planningTerminalOnly(embeddedTerminalManager, sessionId);
    if (!allowed.ok) return allowed;
    const session = embeddedTerminalManager.get(sessionId);
    if (session?.planningSessionId && deps.isPlanningSessionReadOnly?.(session.planningSessionId)) {
      return { ok: false, reason: 'This planning session is read-only.' };
    }
    return embeddedTerminalManager.write(sessionId, data);
  });

  ipcMain.handle('invoker:planning-terminal-resize', async (_event, sessionId: string, cols: number, rows: number) => {
    const allowed = planningTerminalOnly(embeddedTerminalManager, sessionId);
    if (!allowed.ok) return allowed;
    return embeddedTerminalManager.resize(sessionId, cols, rows);
  });

  ipcMain.handle('invoker:planning-terminal-close', async (_event, sessionId: string) => {
    const allowed = planningTerminalOnly(embeddedTerminalManager, sessionId);
    if (!allowed.ok) return allowed;
    return embeddedTerminalManager.close(sessionId);
  });
}

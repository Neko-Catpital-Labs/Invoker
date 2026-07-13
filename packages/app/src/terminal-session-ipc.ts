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

export function terminalRowToDescriptor(row: TerminalSessionRow): TerminalSessionDescriptor {
  return {
    sessionId: row.sessionId,
    taskId: row.taskId,
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
    const live = new Map(embeddedTerminalManager.list().map((session) => [session.sessionId, session]));
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
    const result = embeddedTerminalManager.close(sessionId);
    persistence.deleteTerminalSession(sessionId);
    return result.ok ? result : { ok: true };
  });
}

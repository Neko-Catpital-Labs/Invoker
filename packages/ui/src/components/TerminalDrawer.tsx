/**
 * TerminalDrawer — Bottom drawer hosting embedded xterm.js task terminals.
 *
 * Sessions are owned by the parent (App). Each session is rendered as a
 * tab; an xterm.js instance is mounted per session and routed to the
 * matching `invoker:terminal-*` IPC channels. xterm construction is
 * guarded so jsdom-based component tests can render the drawer without
 * requiring a real terminal backing.
 */

import { useCallback, useEffect, useRef } from 'react';
import { Terminal as XTermTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { TerminalSessionDescriptor } from '@invoker/contracts';

const DRAWER_BODY_HEIGHT_PX = 280;
const TERMINAL_OUTPUT_BURST_FLUSH_MS = 100;

/**
 * The drawer has one explicit state model:
 *   - `minimized`: only the header/tab strip; no terminal body.
 *   - `partial`: today's expanded drawer with a fixed 280px body.
 *   - `maximized`: the drawer covers all app content (graph + side panels)
 *     from under the title bar to the bottom of the window.
 * A single button cycles minimized → partial → maximized → minimized.
 */
export type TerminalDrawerState = 'minimized' | 'partial' | 'maximized';

/** Label/next-state for the single cycling button, keyed by current state. */
const NEXT_STATE_BY_STATE: Record<TerminalDrawerState, { next: TerminalDrawerState; label: string }> = {
  minimized: { next: 'partial', label: 'Partial' },
  partial: { next: 'maximized', label: 'Maximize' },
  maximized: { next: 'minimized', label: 'Minimize' },
};

interface TerminalDrawerProps {
  state: TerminalDrawerState;
  onCycle: () => void;
  sessions: TerminalSessionDescriptor[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  /** Optional taskId → label map (typically task.description). */
  taskLabels?: Map<string, string>;
}

interface TerminalSessionPaneProps {
  session: TerminalSessionDescriptor;
  isActive: boolean;
  hasHeader: boolean;
}

type SeededOutputSnapshot = {
  sessionId: string;
  snapshot: string;
  term: XTermTerminal;
};

type TerminalOutputBurst = {
  timer: ReturnType<typeof setTimeout> | null;
  startedAtMs: number;
  eventCount: number;
  chars: number;
  failedWriteCount: number;
  maxWriteDurationMs: number;
};

type TerminalPerfContext = {
  sessionId: string;
  taskId: string;
  mode: TerminalSessionDescriptor['mode'];
  status: TerminalSessionDescriptor['status'];
  isActive: boolean;
};

function nowMs(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function reportUiPerf(metric: string, data: Record<string, unknown>): void {
  void window.invoker?.reportUiPerf?.(metric, data);
}

function seedTerminalOutputSnapshot(
  term: XTermTerminal,
  session: TerminalSessionDescriptor,
  seededSnapshotRef: { current: SeededOutputSnapshot | null },
  reason: 'attach' | 'snapshot-update',
): void {
  const outputSnapshot = session.outputSnapshot;
  const seededSnapshot = seededSnapshotRef.current;
  if (
    outputSnapshot &&
    (
      !seededSnapshot ||
      seededSnapshot.sessionId !== session.sessionId ||
      seededSnapshot.snapshot !== outputSnapshot ||
      seededSnapshot.term !== term
    )
  ) {
    const startedAtMs = nowMs();
    let failed = false;
    try {
      term.write(outputSnapshot);
      seededSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: outputSnapshot,
        term,
      };
    } catch (err) {
      failed = true;
      console.warn(
        `Failed to seed output snapshot for terminal session ${session.sessionId}:`,
        err,
      );
    }
    reportUiPerf('embedded_terminal_snapshot_seed', {
      sessionId: session.sessionId,
      taskId: session.taskId,
      mode: session.mode,
      status: session.status,
      reason,
      chars: outputSnapshot.length,
      durationMs: roundMs(nowMs() - startedAtMs),
      failed,
    });
  }
}

function TerminalSessionPane({ session, isActive, hasHeader }: TerminalSessionPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seededSnapshotRef = useRef<SeededOutputSnapshot | null>(null);
  const terminalPerfContextRef = useRef<TerminalPerfContext>({
    sessionId: session.sessionId,
    taskId: session.taskId,
    mode: session.mode,
    status: session.status,
    isActive,
  });
  const outputBurstRef = useRef<TerminalOutputBurst>({
    timer: null,
    startedAtMs: 0,
    eventCount: 0,
    chars: 0,
    failedWriteCount: 0,
    maxWriteDurationMs: 0,
  });

  terminalPerfContextRef.current = {
    sessionId: session.sessionId,
    taskId: session.taskId,
    mode: session.mode,
    status: session.status,
    isActive,
  };

  const flushOutputBurst = useCallback((reason: 'timer' | 'unmount'): void => {
    const burst = outputBurstRef.current;
    if (burst.timer !== null) {
      clearTimeout(burst.timer);
      burst.timer = null;
    }
    if (burst.eventCount === 0) return;
    const context = terminalPerfContextRef.current;
    reportUiPerf('embedded_terminal_output_burst', {
      ...context,
      reason,
      durationMs: roundMs(nowMs() - burst.startedAtMs),
      eventCount: burst.eventCount,
      chars: burst.chars,
      failedWriteCount: burst.failedWriteCount,
      maxWriteDurationMs: roundMs(burst.maxWriteDurationMs),
    });
    burst.startedAtMs = 0;
    burst.eventCount = 0;
    burst.chars = 0;
    burst.failedWriteCount = 0;
    burst.maxWriteDurationMs = 0;
  }, []);

  const recordOutputWrite = useCallback((chars: number, durationMs: number, failed: boolean): void => {
    const burst = outputBurstRef.current;
    if (burst.eventCount === 0) {
      burst.startedAtMs = nowMs();
    }
    burst.eventCount += 1;
    burst.chars += chars;
    if (failed) {
      burst.failedWriteCount += 1;
    }
    burst.maxWriteDurationMs = Math.max(burst.maxWriteDurationMs, durationMs);
    if (burst.timer === null) {
      burst.timer = setTimeout(() => flushOutputBurst('timer'), TERMINAL_OUTPUT_BURST_FLUSH_MS);
    }
  }, [flushOutputBurst]);

  useEffect(() => () => flushOutputBurst('unmount'), [flushOutputBurst]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    let term: XTermTerminal;
    let fit: FitAddon;
    const attachStartedAtMs = nowMs();
    let openDurationMs = 0;
    try {
      term = new XTermTerminal({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: { background: '#0b0f1a', foreground: '#e5e7eb' },
      });
      fit = new FitAddon();
      term.loadAddon(fit);
      const openStartedAtMs = nowMs();
      term.open(host);
      openDurationMs = nowMs() - openStartedAtMs;
    } catch {
      return;
    }
    termRef.current = term;
    fitRef.current = fit;

    seedTerminalOutputSnapshot(term, session, seededSnapshotRef, 'attach');
    reportUiPerf('embedded_terminal_attach', {
      sessionId: session.sessionId,
      taskId: session.taskId,
      mode: session.mode,
      status: session.status,
      isActive,
      durationMs: roundMs(nowMs() - attachStartedAtMs),
      openDurationMs: roundMs(openDurationMs),
      hasOutputSnapshot: Boolean(session.outputSnapshot),
      outputSnapshotChars: session.outputSnapshot?.length ?? 0,
    });

    const inputDisposable = term.onData((data) => {
      void window.invoker?.terminalWrite?.(session.sessionId, data);
    });

    const subscribeToOutput = window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? window.invoker?.onTerminalOutput;
    const unsubscribeOutput = subscribeToOutput?.((event) => {
      if (event.sessionId !== session.sessionId) return;
      const writeStartedAtMs = nowMs();
      let failed = false;
      try {
        term.write(event.data);
      } catch {
        failed = true;
        /* terminal disposed */
      } finally {
        recordOutputWrite(event.data.length, nowMs() - writeStartedAtMs, failed);
      }
    });

    const tryFit = () => {
      try {
        fit.fit();
        void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
      } catch {
        /* host has zero size or fit unsupported */
      }
    };

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(tryFit)
      : null;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      try {
        resizeObserver = new ResizeObserver(() => {
          tryFit();
        });
        resizeObserver.observe(host);
      } catch {
        resizeObserver = null;
      }
    }

    return () => {
      if (raf !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      resizeObserver?.disconnect();
      inputDisposable.dispose();
      unsubscribeOutput?.();
      try {
        term.dispose();
      } catch {
        /* already disposed */
      }
      flushOutputBurst('unmount');
      termRef.current = null;
      fitRef.current = null;
    };
  }, [flushOutputBurst, recordOutputWrite, session.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    seedTerminalOutputSnapshot(term, session, seededSnapshotRef, 'snapshot-update');
  }, [session.outputSnapshot, session.sessionId]);

  useEffect(() => {
    if (!isActive) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
      void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
    } catch {
      /* fit failed (e.g., hidden) */
    }
  }, [isActive, session.sessionId]);

  return (
    <div
      ref={containerRef}
      data-testid={`terminal-pane-${session.taskId}`}
      data-session-id={session.sessionId}
      className={hasHeader ? 'absolute bottom-0 left-0 right-0 top-9 overflow-hidden' : 'absolute inset-0 overflow-hidden'}
      style={{ display: isActive ? 'block' : 'none' }}
    />
  );
}

export function TerminalDrawer({
  state,
  onCycle,
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  taskLabels,
}: TerminalDrawerProps): JSX.Element {
  const isMaximized = state === 'maximized';
  const showBody = state !== 'minimized';
  const cycleLabel = NEXT_STATE_BY_STATE[state].label;
  const activeSession = sessions.find((session) => session.sessionId === activeSessionId) ?? null;
  const activeCommand = activeSession?.command
    ? [activeSession.command, ...(activeSession.args ?? [])].join(' ')
    : null;

  return (
    <div
      data-testid="terminal-drawer"
      data-state={state}
      className={
        isMaximized
          ? 'fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden border-t border-border bg-card'
          : 'border-t border-border bg-card'
      }
    >
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <div
          role="tablist"
          data-testid="terminal-tab-strip"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {sessions.length === 0 ? (
            <span className="text-xs text-muted-foreground">No terminal sessions</span>
          ) : (
            sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              const label = taskLabels?.get(session.taskId) ?? session.taskId;
              const tabClass = isActive
                ? 'border-border-strong bg-secondary text-white'
                : 'border-transparent text-muted-foreground hover:bg-secondary/60';
              return (
                <div
                  key={session.sessionId}
                  data-testid={`terminal-tab-${session.taskId}`}
                  data-active={isActive ? 'true' : 'false'}
                  className={`flex shrink-0 items-center gap-1 rounded border ${tabClass}`}
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => onSelectSession(session.sessionId)}
                    className="max-w-[180px] truncate px-2 py-0.5 text-xs"
                    title={label}
                  >
                    {label}
                    {session.status === 'exited' && (
                      <span className="ml-1 text-[10px] text-amber-300">exited</span>
                    )}
                  </button>
                  <button
                    type="button"
                    aria-label={`Close terminal for ${label}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseSession(session.sessionId);
                    }}
                    className="px-1 text-xs text-muted-foreground hover:text-white"
                  >
                    ×
                  </button>
                </div>
              );
            })
          )}
        </div>
        <button
          type="button"
          onClick={onCycle}
          aria-label={`${cycleLabel} terminal drawer`}
          className="shrink-0 rounded border border-border px-2 py-1 text-[11px] text-muted-foreground hover:bg-secondary"
        >
          {cycleLabel}
        </button>
      </div>
      {showBody && (
        <div
          data-testid="terminal-drawer-body"
          className={isMaximized ? 'relative min-h-0 flex-1 overflow-hidden bg-black' : 'relative overflow-hidden bg-black'}
          style={isMaximized ? undefined : { height: DRAWER_BODY_HEIGHT_PX }}
        >
          {sessions.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center px-3 text-xs text-muted-foreground">
              Open a terminal from a task to attach.
            </div>
          )}
          {activeSession && activeCommand && (
            <div
              data-testid="terminal-session-command"
              className="absolute left-0 right-0 top-0 z-10 flex h-9 items-center gap-2 border-b border-border bg-card px-3 text-[11px]"
            >
              <span className="text-muted-foreground">SSH</span>
              <span className="min-w-0 flex-1 truncate font-mono text-emerald-200">
                {activeCommand}
              </span>
            </div>
          )}
          {sessions.map((session) => (
            <TerminalSessionPane
              key={session.sessionId}
              session={session}
              isActive={session.sessionId === activeSessionId}
              hasHeader={Boolean(session.sessionId === activeSessionId && activeCommand)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

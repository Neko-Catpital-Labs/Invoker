/**
 * TerminalDrawer — Bottom drawer hosting embedded xterm.js task terminals.
 *
 * Sessions are owned by the parent (App). Each session is rendered as a
 * tab; an xterm.js instance is mounted per session and routed to the
 * matching `invoker:terminal-*` IPC channels. xterm construction is
 * guarded so jsdom-based component tests can render the drawer without
 * requiring a real terminal backing.
 */

import { useEffect, useRef } from 'react';
import { Terminal as XTermTerminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import type { TerminalSessionDescriptor } from '@invoker/contracts';

const DRAWER_BODY_HEIGHT_PX = 280;
const TERMINAL_RENDERER_FIT_SLOW_MS = 16;
const TERMINAL_RENDERER_OUTPUT_SLOW_MS = 16;
const TERMINAL_RENDERER_OUTPUT_REPORT_CHUNKS = 50;
const TERMINAL_RENDERER_OUTPUT_REPORT_CHARS = 32_768;
const TERMINAL_RENDERER_OUTPUT_REPORT_MIN_INTERVAL_MS = 250;

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

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

function roundMs(value: number): number {
  return Math.round(value * 10) / 10;
}

function reportTerminalRendererPerf(metric: string, data: Record<string, unknown>): void {
  if (typeof window === 'undefined') return;
  void window.invoker?.reportUiPerf?.(metric, data);
}

function seedTerminalOutputSnapshot(
  term: XTermTerminal,
  session: TerminalSessionDescriptor,
  seededSnapshotRef: { current: SeededOutputSnapshot | null },
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
    try {
      const startedAt = nowMs();
      term.write(outputSnapshot);
      const durationMs = nowMs() - startedAt;
      seededSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: outputSnapshot,
        term,
      };
      reportTerminalRendererPerf('terminal_renderer_snapshot_seed', {
        durationMs: roundMs(durationMs),
        chars: outputSnapshot.length,
        sessionId: session.sessionId,
        taskId: session.taskId,
        status: session.status,
        mode: session.mode,
      });
    } catch (err) {
      console.warn(
        `Failed to seed output snapshot for terminal session ${session.sessionId}:`,
        err,
      );
    }
  }
}

function TerminalSessionPane({ session, isActive, hasHeader }: TerminalSessionPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seededSnapshotRef = useRef<SeededOutputSnapshot | null>(null);
  const isActiveRef = useRef(isActive);
  const inputPerfRef = useRef({ count: 0 });
  const fitPerfRef = useRef({ count: 0 });
  const outputPerfRef = useRef({
    totalChunks: 0,
    totalChars: 0,
    chunksSinceReport: 0,
    charsSinceReport: 0,
    lastReportedAt: 0,
  });

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    let term: XTermTerminal;
    let fit: FitAddon;
    try {
      const attachStartedAt = nowMs();
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
      term.open(host);
      reportTerminalRendererPerf('terminal_renderer_attach', {
        durationMs: roundMs(nowMs() - attachStartedAt),
        sessionId: session.sessionId,
        taskId: session.taskId,
        status: session.status,
        mode: session.mode,
        snapshotChars: session.outputSnapshot?.length ?? 0,
      });
    } catch {
      return;
    }
    termRef.current = term;
    fitRef.current = fit;

    seedTerminalOutputSnapshot(term, session, seededSnapshotRef);

    const inputDisposable = term.onData((data) => {
      const startedAt = nowMs();
      void window.invoker?.terminalWrite?.(session.sessionId, data);
      const durationMs = nowMs() - startedAt;
      inputPerfRef.current.count += 1;
      reportTerminalRendererPerf('terminal_renderer_input', {
        durationMs: roundMs(durationMs),
        inputCount: inputPerfRef.current.count,
        chars: data.length,
        sessionId: session.sessionId,
        taskId: session.taskId,
        active: isActiveRef.current,
      });
    });

    const subscribeToOutput = window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? window.invoker?.onTerminalOutput;
    const unsubscribeOutput = subscribeToOutput?.((event) => {
      if (event.sessionId !== session.sessionId) return;
      try {
        const startedAt = nowMs();
        term.write(event.data);
        const durationMs = nowMs() - startedAt;
        const perf = outputPerfRef.current;
        const chars = event.data.length;
        perf.totalChunks += 1;
        perf.totalChars += chars;
        perf.chunksSinceReport += 1;
        perf.charsSinceReport += chars;
        const slow = durationMs >= TERMINAL_RENDERER_OUTPUT_SLOW_MS;
        const burst =
          perf.chunksSinceReport >= TERMINAL_RENDERER_OUTPUT_REPORT_CHUNKS ||
          perf.charsSinceReport >= TERMINAL_RENDERER_OUTPUT_REPORT_CHARS;
        const now = Date.now();
        const intervalElapsed = now - perf.lastReportedAt >= TERMINAL_RENDERER_OUTPUT_REPORT_MIN_INTERVAL_MS;
        if (slow || (burst && intervalElapsed)) {
          reportTerminalRendererPerf('terminal_renderer_output_write', {
            durationMs: roundMs(durationMs),
            chunkChars: chars,
            chunksSinceReport: perf.chunksSinceReport,
            charsSinceReport: perf.charsSinceReport,
            totalChunks: perf.totalChunks,
            totalChars: perf.totalChars,
            slow,
            burst,
            sessionId: session.sessionId,
            taskId: session.taskId,
            active: isActiveRef.current,
          });
          perf.lastReportedAt = now;
          perf.chunksSinceReport = 0;
          perf.charsSinceReport = 0;
        }
      } catch {
        /* terminal disposed */
      }
    });

    const tryFit = () => {
      try {
        const startedAt = nowMs();
        fit.fit();
        void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
        const durationMs = nowMs() - startedAt;
        fitPerfRef.current.count += 1;
        if (durationMs >= TERMINAL_RENDERER_FIT_SLOW_MS || fitPerfRef.current.count <= 2) {
          reportTerminalRendererPerf('terminal_renderer_fit', {
            durationMs: roundMs(durationMs),
            fitCount: fitPerfRef.current.count,
            cols: term.cols,
            rows: term.rows,
            sessionId: session.sessionId,
            taskId: session.taskId,
            active: isActiveRef.current,
          });
        }
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
      termRef.current = null;
      fitRef.current = null;
    };
  }, [session.sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    seedTerminalOutputSnapshot(term, session, seededSnapshotRef);
  }, [session.outputSnapshot, session.sessionId]);

  useEffect(() => {
    if (!isActive) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      const startedAt = nowMs();
      fit.fit();
      void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
      const durationMs = nowMs() - startedAt;
      fitPerfRef.current.count += 1;
      if (durationMs >= TERMINAL_RENDERER_FIT_SLOW_MS || fitPerfRef.current.count <= 2) {
        reportTerminalRendererPerf('terminal_renderer_fit', {
          durationMs: roundMs(durationMs),
          fitCount: fitPerfRef.current.count,
          cols: term.cols,
          rows: term.rows,
          sessionId: session.sessionId,
          taskId: session.taskId,
          active: isActiveRef.current,
          reason: 'active-session',
        });
      }
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

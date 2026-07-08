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

// Embedded-terminal output writes are aggregated into bursts flushed at most
// once per window; heavy xterm traffic then reports as one pressure sample
// (bytes / writes / max write ms) instead of one IPC per write.
const TERMINAL_OUTPUT_BURST_WINDOW_MS = 1000;

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

function seedTerminalOutputSnapshot(
  term: XTermTerminal,
  session: TerminalSessionDescriptor,
  seededSnapshotRef: { current: SeededOutputSnapshot | null },
): number {
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
      const startedAt = performance.now();
      term.write(outputSnapshot);
      seededSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: outputSnapshot,
        term,
      };
      return performance.now() - startedAt;
    } catch (err) {
      console.warn(
        `Failed to seed output snapshot for terminal session ${session.sessionId}:`,
        err,
      );
    }
  }
  return 0;
}

function TerminalSessionPane({ session, isActive, hasHeader }: TerminalSessionPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seededSnapshotRef = useRef<SeededOutputSnapshot | null>(null);
  const activeReportRef = useRef(false);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    const attachStartedAt = performance.now();

    // Aggregate xterm output writes into throttled bursts over the existing
    // owner-side reportUiPerf (`ui-perf`) path — one report per window, not one
    // IPC per write. Flushed on the window boundary and on unmount so the
    // trailing burst is never lost.
    let outputBurst:
      | { bytes: number; writes: number; writeMs: number; maxWriteMs: number; windowStartAt: number }
      | null = null;
    const flushOutputBurst = (): void => {
      const burst = outputBurst;
      outputBurst = null;
      if (!burst || burst.writes === 0) return;
      if (typeof window === 'undefined' || !window.invoker) return;
      void window.invoker.reportUiPerf?.('terminal_output_burst', {
        bytes: burst.bytes,
        writes: burst.writes,
        writeMs: Math.round(burst.writeMs),
        maxWriteMs: Math.round(burst.maxWriteMs),
        windowMs: Math.round(Date.now() - burst.windowStartAt),
      });
    };

    let term: XTermTerminal;
    let fit: FitAddon;
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
      term.open(host);
    } catch {
      return;
    }
    termRef.current = term;
    fitRef.current = fit;

    const seedWriteMs = seedTerminalOutputSnapshot(term, session, seededSnapshotRef);
    if (typeof window !== 'undefined' && window.invoker) {
      // One-shot attach cost (xterm construction + open + snapshot seed).
      void window.invoker.reportUiPerf?.('terminal_attach', {
        attachMs: Math.round(performance.now() - attachStartedAt),
        snapshotBytes: session.outputSnapshot?.length ?? 0,
      });
      if (session.outputSnapshot) {
        void window.invoker.reportUiPerf?.('terminal_seed_output_snapshot', {
          bytes: session.outputSnapshot.length,
          writeMs: Math.round(seedWriteMs),
        });
      }
    }

    const inputDisposable = term.onData((data) => {
      void window.invoker?.terminalWrite?.(session.sessionId, data);
    });

    const subscribeToOutput = window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? window.invoker?.onTerminalOutput;
    const unsubscribeOutput = subscribeToOutput?.((event) => {
      if (event.sessionId !== session.sessionId) return;
      const writeStartedAt = performance.now();
      try {
        term.write(event.data);
      } catch {
        /* terminal disposed */
      }
      const writeMs = performance.now() - writeStartedAt;
      const nowMs = Date.now();
      if (!outputBurst) {
        outputBurst = { bytes: 0, writes: 0, writeMs: 0, maxWriteMs: 0, windowStartAt: nowMs };
      }
      outputBurst.bytes += event.data.length;
      outputBurst.writes += 1;
      outputBurst.writeMs += writeMs;
      outputBurst.maxWriteMs = Math.max(outputBurst.maxWriteMs, writeMs);
      if (nowMs - outputBurst.windowStartAt >= TERMINAL_OUTPUT_BURST_WINDOW_MS) {
        flushOutputBurst();
      }
    });

    const tryFit = (source: 'initial' | 'resize' | 'switch') => {
      try {
        const startedAt = performance.now();
        fit.fit();
        void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
        void window.invoker?.reportUiPerf?.('terminal_fit', {
          source,
          fitMs: Math.round(performance.now() - startedAt),
          cols: term.cols,
          rows: term.rows,
        });
      } catch {
        /* host has zero size or fit unsupported */
      }
    };

    const raf = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(() => tryFit('initial'))
      : null;

    let resizeObserver: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      try {
        resizeObserver = new ResizeObserver(() => tryFit('resize'));
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
      flushOutputBurst();
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
    const seedWriteMs = seedTerminalOutputSnapshot(term, session, seededSnapshotRef);
    if (seedWriteMs > 0) {
      void window.invoker?.reportUiPerf?.('terminal_seed_output_snapshot', {
        bytes: session.outputSnapshot?.length ?? 0,
        writeMs: Math.round(seedWriteMs),
      });
    }
  }, [session.outputSnapshot, session.sessionId]);

  useEffect(() => {
    if (!isActive) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit) return;
    try {
      const startedAt = performance.now();
      fit.fit();
      void window.invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
      const fitMs = Math.round(performance.now() - startedAt);
      void window.invoker?.reportUiPerf?.('terminal_fit', {
        source: 'switch',
        fitMs,
        cols: term.cols,
        rows: term.rows,
      });
      void window.invoker?.reportUiPerf?.('terminal_switch', {
        initial: !activeReportRef.current,
        fitMs,
        cols: term.cols,
        rows: term.rows,
      });
      activeReportRef.current = true;
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
          ? 'fixed inset-0 z-40 flex min-h-0 flex-col overflow-hidden border-t border-gray-800 bg-gray-950'
          : 'border-t border-gray-800 bg-gray-950'
      }
    >
      <div className="flex items-center gap-2 border-b border-gray-800 px-3 py-2">
        <div
          role="tablist"
          data-testid="terminal-tab-strip"
          className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto"
        >
          {sessions.length === 0 ? (
            <span className="text-xs text-gray-500">No terminal sessions</span>
          ) : (
            sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              const label = taskLabels?.get(session.taskId) ?? session.taskId;
              const tabClass = isActive
                ? 'border-gray-500 bg-gray-800 text-white'
                : 'border-transparent text-gray-300 hover:bg-gray-800/60';
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
                    className="px-1 text-xs text-gray-400 hover:text-white"
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
          className="shrink-0 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
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
            <div className="absolute inset-0 flex items-center justify-center px-3 text-xs text-gray-500">
              Open a terminal from a task to attach.
            </div>
          )}
          {activeSession && activeCommand && (
            <div
              data-testid="terminal-session-command"
              className="absolute left-0 right-0 top-0 z-10 flex h-9 items-center gap-2 border-b border-gray-800 bg-gray-950 px-3 text-[11px]"
            >
              <span className="text-gray-500">SSH</span>
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

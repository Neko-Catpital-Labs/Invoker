import { useEffect, useRef } from 'react';
import type { Terminal as XTermTerminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

const DRAWER_BODY_HEIGHT_PX = 280;

export type TerminalDrawerState = 'minimized' | 'partial' | 'maximized';

export interface TerminalSessionDescriptor {
  sessionId: string;
  taskId: string;
  status: 'running' | 'exited';
  exitCode?: number;
  cwd?: string;
  command?: string;
  args?: string[];
  mode?: 'spawn' | 'attached';
  attached?: boolean;
  createdAt: string;
  outputSnapshot?: string;
}

export interface TerminalOutputEvent {
  sessionId: string;
  taskId: string;
  data: string;
}

export interface OpenTerminalResponse {
  opened: boolean;
  reason?: string;
  session?: TerminalSessionDescriptor;
}

declare global {
  interface Window {
    __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: (cb: (event: TerminalOutputEvent) => void) => () => void;
    __INVOKER_TEST_TERMINAL_CONSTRUCTORS__?: TerminalConstructors;
  }
}

interface TerminalDrawerProps {
  state: TerminalDrawerState;
  onCycle: () => void;
  sessions: TerminalSessionDescriptor[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
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

const NEXT_STATE_BY_STATE: Record<TerminalDrawerState, { next: TerminalDrawerState; label: string; ariaLabel: string }> = {
  minimized: { next: 'partial', label: 'Expand', ariaLabel: 'Expand terminal drawer' },
  partial: { next: 'maximized', label: 'Maximize', ariaLabel: 'Maximize terminal drawer' },
  maximized: { next: 'minimized', label: 'Minimize', ariaLabel: 'Minimize terminal drawer' },
};

type TerminalApi = {
  terminalWrite?: (sessionId: string, data: string) => Promise<unknown>;
  terminalResize?: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
  terminalClose?: (sessionId: string) => Promise<unknown>;
  onTerminalOutput?: (cb: (event: TerminalOutputEvent) => void) => () => void;
};

type TerminalConstructors = {
  Terminal: typeof import('xterm').Terminal;
  FitAddon: typeof import('xterm-addon-fit').FitAddon;
};

function terminalApi(): TerminalApi {
  return (window.invoker ?? {}) as unknown as TerminalApi;
}

async function loadTerminalConstructors(): Promise<TerminalConstructors> {
  const testConstructors = window.__INVOKER_TEST_TERMINAL_CONSTRUCTORS__;
  if (testConstructors) return testConstructors;

  const [xtermModule, fitModule] = await Promise.all([
    import('xterm'),
    import('xterm-addon-fit'),
  ]);
  return {
    Terminal: xtermModule.Terminal,
    FitAddon: fitModule.FitAddon,
  };
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
      term.write(outputSnapshot);
      seededSnapshotRef.current = {
        sessionId: session.sessionId,
        snapshot: outputSnapshot,
        term,
      };
    } catch {
      /* terminal disposed */
    }
  }
}

function TerminalSessionPane({ session, isActive, hasHeader }: TerminalSessionPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTermTerminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const seededSnapshotRef = useRef<SeededOutputSnapshot | null>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    let disposed = false;
    let cleanup: (() => void) | null = null;

    void loadTerminalConstructors().then(({ Terminal, FitAddon }) => {
      if (disposed) return;

      let term: XTermTerminal;
      let fit: FitAddon;
      try {
        term = new Terminal({
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

      if (disposed) {
        try {
          term.dispose();
        } catch {
          /* already disposed */
        }
        return;
      }

      termRef.current = term;
      fitRef.current = fit;
      seedTerminalOutputSnapshot(term, session, seededSnapshotRef);

      const inputDisposable = term.onData((data) => {
        void terminalApi().terminalWrite?.(session.sessionId, data);
      });

      const subscribeToOutput = window.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? terminalApi().onTerminalOutput;
      const unsubscribeOutput = subscribeToOutput?.((event) => {
        if (event.sessionId !== session.sessionId) return;
        try {
          term.write(event.data);
        } catch {
          /* terminal disposed */
        }
      });

      const tryFit = () => {
        try {
          fit.fit();
          void terminalApi().terminalResize?.(session.sessionId, term.cols, term.rows);
        } catch {
          /* host has zero size or fit unsupported */
        }
      };

      const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame(tryFit) : null;
      let resizeObserver: ResizeObserver | null = null;
      if (typeof ResizeObserver !== 'undefined') {
        try {
          resizeObserver = new ResizeObserver(tryFit);
          resizeObserver.observe(host);
        } catch {
          resizeObserver = null;
        }
      }
      if (isActive) {
        tryFit();
        try {
          term.focus();
        } catch {
          /* focus unsupported */
        }
      }

      cleanup = () => {
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
    });

    return () => {
      disposed = true;
      cleanup?.();
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
      fit.fit();
      void terminalApi().terminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
    } catch {
      /* fit failed */
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
  const cycle = NEXT_STATE_BY_STATE[state];
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
            <span className="text-xs text-gray-400">No terminal sessions</span>
          ) : (
            sessions.map((session) => {
              const isActive = session.sessionId === activeSessionId;
              const label = taskLabels?.get(session.taskId) ?? session.taskId;
              return (
                <div
                  key={session.sessionId}
                  data-testid={`terminal-tab-${session.taskId}`}
                  data-active={isActive ? 'true' : 'false'}
                  className={
                    isActive
                      ? 'flex shrink-0 items-center gap-1 rounded border border-gray-500 bg-gray-800 text-white'
                      : 'flex shrink-0 items-center gap-1 rounded border border-transparent text-gray-400 hover:bg-gray-800'
                  }
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
                    x
                  </button>
                </div>
              );
            })
          )}
        </div>
        <button
          type="button"
          onClick={onCycle}
          aria-label={cycle.ariaLabel}
          className="shrink-0 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {cycle.label}
        </button>
      </div>
      {showBody && (
        <div
          data-testid="terminal-drawer-body"
          className={isMaximized ? 'relative min-h-0 flex-1 overflow-hidden bg-black' : 'relative overflow-hidden bg-black'}
          style={isMaximized ? undefined : { height: DRAWER_BODY_HEIGHT_PX }}
        >
          {sessions.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center px-3 text-xs text-gray-400">
              Open a terminal from a task to attach.
            </div>
          )}
          {activeSession && activeCommand && (
            <div
              data-testid="terminal-session-command"
              className="absolute left-0 right-0 top-0 z-10 flex h-9 items-center gap-2 border-b border-gray-800 bg-gray-950 px-3 text-[11px]"
            >
              <span className="text-gray-400">SSH</span>
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

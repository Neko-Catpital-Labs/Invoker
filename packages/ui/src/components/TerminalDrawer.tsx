import { useEffect, useRef } from 'react';
import type { Terminal as XTermTerminal } from 'xterm';
import type { FitAddon } from 'xterm-addon-fit';

const DRAWER_BODY_HEIGHT_PX = 280;

export type TerminalDrawerState = 'minimized' | 'partial' | 'maximized';

export interface TerminalSessionDescriptor {
  sessionId: string;
  taskId: string;
  status: 'running' | 'exited';
  mode?: string;
  attached?: boolean;
  createdAt?: string;
  cwd?: string;
  command?: string;
  args?: string[];
  outputSnapshot?: string;
}

interface LegacyTerminalDrawerProps {
  collapsed: boolean;
  onToggle: () => void;
}

interface SessionTerminalDrawerProps {
  state: TerminalDrawerState;
  onCycle: () => void;
  sessions: TerminalSessionDescriptor[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
  taskLabels?: Map<string, string>;
}

type TerminalDrawerProps = LegacyTerminalDrawerProps | SessionTerminalDrawerProps;

interface TerminalSessionPaneProps {
  session: TerminalSessionDescriptor;
  isActive: boolean;
  hasHeader: boolean;
}

interface TerminalOutputEvent {
  sessionId: string;
  taskId?: string;
  data: string;
}

interface TerminalInvokerMethods {
  terminalWrite?: (sessionId: string, data: string) => Promise<void>;
  terminalResize?: (sessionId: string, cols: number, rows: number) => Promise<void>;
  onTerminalOutput?: (cb: (event: TerminalOutputEvent) => void) => () => void;
}

interface TerminalTestWindow {
  __INVOKER_TEST_ON_TERMINAL_OUTPUT__?: (cb: (event: TerminalOutputEvent) => void) => () => void;
  __INVOKER_TEST_XTERM__?: {
    Terminal: new (options: Record<string, unknown>) => XTermTerminal;
    FitAddon: new () => FitAddon;
  };
}

type SeededOutputSnapshot = {
  sessionId: string;
  snapshot: string;
  term: XTermTerminal;
};

const NEXT_STATE_BY_STATE: Record<TerminalDrawerState, { label: string }> = {
  minimized: { label: 'Partial' },
  partial: { label: 'Maximize' },
  maximized: { label: 'Minimize' },
};

function isSessionProps(props: TerminalDrawerProps): props is SessionTerminalDrawerProps {
  return 'state' in props;
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
  const isActiveRef = useRef(isActive);

  useEffect(() => {
    isActiveRef.current = isActive;
  }, [isActive]);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;

    let disposed = false;
    let term: XTermTerminal | null = null;
    let fit: FitAddon | null = null;
    let inputDisposable: { dispose: () => void } | null = null;
    let unsubscribeOutput: (() => void) | undefined;
    let raf: number | null = null;
    let resizeObserver: ResizeObserver | null = null;

    const cleanupTerminal = () => {
      if (raf !== null && typeof cancelAnimationFrame === 'function') {
        cancelAnimationFrame(raf);
      }
      resizeObserver?.disconnect();
      inputDisposable?.dispose();
      unsubscribeOutput?.();
      try {
        term?.dispose();
      } catch {
        /* already disposed */
      }
      termRef.current = null;
      fitRef.current = null;
    };

    const testWindow = window as typeof window & TerminalTestWindow;
    const constructors = testWindow.__INVOKER_TEST_XTERM__
      ? Promise.resolve(testWindow.__INVOKER_TEST_XTERM__)
      : Promise.all([
        import('xterm'),
        import('xterm-addon-fit'),
      ]).then(([xtermModule, fitModule]) => ({
        Terminal: xtermModule.Terminal,
        FitAddon: fitModule.FitAddon,
      }));

    void constructors.then(({ Terminal: TerminalCtor, FitAddon: FitAddonCtor }) => {
      if (disposed || !host.isConnected) return;

      term = new TerminalCtor({
        fontSize: 12,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        cursorBlink: true,
        convertEol: false,
        scrollback: 5000,
        theme: { background: '#0b0f1a', foreground: '#e5e7eb' },
      });
      fit = new FitAddonCtor();
      term.loadAddon(fit);
      term.open(host);
      termRef.current = term;
      fitRef.current = fit;

      seedTerminalOutputSnapshot(term, session, seededSnapshotRef);

      const invoker = window.invoker as (typeof window.invoker & TerminalInvokerMethods) | undefined;
      inputDisposable = term.onData((data) => {
        void invoker?.terminalWrite?.(session.sessionId, data);
      });

      const subscribeToOutput = testWindow.__INVOKER_TEST_ON_TERMINAL_OUTPUT__ ?? invoker?.onTerminalOutput;
      unsubscribeOutput = subscribeToOutput?.((event) => {
        if (event.sessionId !== session.sessionId || !term) return;
        try {
          term.write(event.data);
        } catch {
          /* terminal disposed */
        }
      });

      const tryFit = () => {
        if (!term || !fit) return;
        try {
          fit.fit();
          void invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
        } catch {
          /* host has zero size or fit unsupported */
        }
      };

      raf = typeof requestAnimationFrame === 'function'
        ? requestAnimationFrame(tryFit)
        : null;

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

      if (isActiveRef.current) {
        tryFit();
        try {
          term.focus();
        } catch {
          /* terminal disposed */
        }
      }
    }).catch(() => {});

    return () => {
      disposed = true;
      cleanupTerminal();
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
    const invoker = window.invoker as (typeof window.invoker & TerminalInvokerMethods) | undefined;
    try {
      fit.fit();
      void invoker?.terminalResize?.(session.sessionId, term.cols, term.rows);
      term.focus();
    } catch {
      /* fit failed (e.g. hidden) */
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

function LegacyTerminalDrawer({ collapsed, onToggle }: LegacyTerminalDrawerProps): JSX.Element {
  return (
    <div className="border-t border-gray-800 bg-gray-950">
      <div className="flex items-center justify-between px-3 py-2 border-b border-gray-800">
        <div className="flex items-center gap-3 text-xs text-gray-300">
          <button className="hover:text-white">Terminal</button>
          <button className="hover:text-white">Logs</button>
          <button className="hover:text-white">Problems</button>
        </div>
        <button
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Collapse terminal drawer'}
          className="rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>
      {!collapsed && (
        <div className="h-40 px-3 py-2 text-xs text-gray-400 overflow-auto">
          Terminal drawer reserved for embedded shell/log surfaces.
        </div>
      )}
    </div>
  );
}

function SessionTerminalDrawer({
  state,
  onCycle,
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
  taskLabels,
}: SessionTerminalDrawerProps): JSX.Element {
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

export function TerminalDrawer(props: TerminalDrawerProps): JSX.Element {
  return isSessionProps(props) ? <SessionTerminalDrawer {...props} /> : <LegacyTerminalDrawer {...props} />;
}

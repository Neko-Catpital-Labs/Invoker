/**
 * TerminalDrawer — bottom drawer that hosts embedded task terminals.
 *
 * Each open terminal session is a tab. The active tab mounts an xterm.js
 * instance bound to the main-process PTY via `window.invoker.terminal*`
 * IPC. Inactive sessions stay mounted (offscreen) so backlog output keeps
 * accumulating while the user is on another tab.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import type { TerminalSessionDescriptor } from '@invoker/contracts';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';

export interface TerminalDrawerSession extends TerminalSessionDescriptor {
  /** Human label for the tab — derived from the task id when not provided. */
  label?: string;
}

interface TerminalDrawerProps {
  collapsed: boolean;
  onToggle: () => void;
  sessions: TerminalDrawerSession[];
  activeSessionId: string | null;
  onSelectSession: (sessionId: string) => void;
  onCloseSession: (sessionId: string) => void;
}

export function TerminalDrawer({
  collapsed,
  onToggle,
  sessions,
  activeSessionId,
  onSelectSession,
  onCloseSession,
}: TerminalDrawerProps): JSX.Element {
  const hasSessions = sessions.length > 0;

  return (
    <div
      data-testid="terminal-drawer"
      data-collapsed={collapsed ? 'true' : 'false'}
      className="border-t border-gray-800 bg-gray-950"
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-gray-800">
        <div
          data-testid="terminal-drawer-tabs"
          className="flex flex-1 min-w-0 items-center gap-1 overflow-x-auto"
        >
          {hasSessions ? (
            sessions.map((session) => (
              <TerminalTab
                key={session.sessionId}
                session={session}
                active={session.sessionId === activeSessionId}
                onSelect={() => onSelectSession(session.sessionId)}
                onClose={() => onCloseSession(session.sessionId)}
              />
            ))
          ) : (
            <span className="text-xs text-gray-400">Terminal</span>
          )}
        </div>
        <button
          data-testid="terminal-drawer-toggle"
          onClick={onToggle}
          aria-label={collapsed ? 'Expand terminal drawer' : 'Minimize terminal drawer'}
          className="shrink-0 rounded border border-gray-700 px-2 py-1 text-[11px] text-gray-300 hover:bg-gray-800"
        >
          {collapsed ? 'Expand' : 'Minimize'}
        </button>
      </div>
      {!collapsed && (
        <div
          data-testid="terminal-drawer-body"
          className="relative h-48 bg-black"
        >
          {sessions.map((session) => (
            <TerminalPane
              key={session.sessionId}
              session={session}
              active={session.sessionId === activeSessionId}
            />
          ))}
          {!hasSessions && (
            <div
              data-testid="terminal-drawer-empty"
              className="absolute inset-0 flex items-center justify-center text-xs text-gray-500"
            >
              Double-click a task or use “Open Terminal” to start a session.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TerminalTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: TerminalDrawerSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}): JSX.Element {
  const baseClass =
    'flex shrink-0 items-center gap-1 rounded-t border border-transparent px-2 py-1 text-xs cursor-pointer max-w-[180px]';
  const activeClass = active
    ? 'bg-gray-800 text-white border-gray-700 border-b-transparent'
    : 'text-gray-300 hover:bg-gray-800/70';
  const label = session.label ?? `Task ${session.taskId}`;
  const exited = session.status === 'exited' || session.status === 'error';

  return (
    <div
      data-testid={`terminal-tab-${session.taskId}`}
      data-active={active ? 'true' : 'false'}
      data-status={session.status}
      role="tab"
      aria-selected={active}
      onClick={onSelect}
      className={`${baseClass} ${activeClass}`}
      title={`${label}${exited ? ' (exited)' : ''}`}
    >
      <span className={`truncate ${exited ? 'text-gray-500 line-through' : ''}`}>{label}</span>
      <button
        data-testid={`terminal-tab-close-${session.taskId}`}
        aria-label={`Close terminal for ${label}`}
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
        className="shrink-0 rounded px-1 text-[11px] text-gray-400 hover:bg-gray-700 hover:text-white"
      >
        ×
      </button>
    </div>
  );
}

interface TerminalPaneProps {
  session: TerminalDrawerSession;
  active: boolean;
}

function TerminalPane({ session, active }: TerminalPaneProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const writeBufferRef = useRef<string[]>([]);
  const sessionId = session.sessionId;
  const taskId = session.taskId;

  const fit = useCallback(() => {
    const term = terminalRef.current;
    const fit = fitAddonRef.current;
    if (!term || !fit) return;
    try {
      fit.fit();
    } catch {
      /* jsdom or zero-sized container — fit is a best-effort op */
    }
  }, []);

  const writeToTerm = useCallback((data: string) => {
    const term = terminalRef.current;
    if (term) {
      try {
        term.write(data);
      } catch {
        /* terminal disposed mid-write */
      }
    } else {
      writeBufferRef.current.push(data);
    }
  }, []);

  // Mount the xterm instance once per session id.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let term: Terminal | null = null;
    let fitAddon: FitAddon | null = null;
    const disposables: Array<{ dispose: () => void }> = [];

    try {
      term = new Terminal({
        cursorBlink: true,
        convertEol: true,
        fontFamily:
          'ui-monospace, SFMono-Regular, "SF Mono", Consolas, "Liberation Mono", Menlo, monospace',
        fontSize: 12,
        theme: { background: '#000000', foreground: '#e5e7eb' },
        scrollback: 5000,
      });
      fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(container);
      try {
        fitAddon.fit();
      } catch {
        /* noop */
      }
    } catch {
      // xterm mount can throw in jsdom (no canvas, no layout). Keep the
      // refs null so writes/resizes silently no-op until the user opens the
      // drawer in a real browser.
      term = null;
      fitAddon = null;
    }

    terminalRef.current = term;
    fitAddonRef.current = fitAddon;

    // Flush any buffered output that arrived before xterm mounted.
    if (term) {
      const buffered = writeBufferRef.current;
      writeBufferRef.current = [];
      for (const chunk of buffered) {
        try {
          term.write(chunk);
        } catch {
          /* noop */
        }
      }

      try {
        disposables.push(
          term.onData((data) => {
            window.invoker?.terminalWrite?.(sessionId, data);
          }),
        );
      } catch {
        /* noop */
      }
      try {
        disposables.push(
          term.onResize(({ cols, rows }) => {
            window.invoker?.terminalResize?.(sessionId, cols, rows);
          }),
        );
      } catch {
        /* noop */
      }
    }

    return () => {
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* noop */
        }
      }
      try {
        term?.dispose();
      } catch {
        /* noop */
      }
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [sessionId]);

  // Subscribe to output for this session.
  useEffect(() => {
    if (!window.invoker?.onTerminalOutput) return;
    const off = window.invoker.onTerminalOutput((event) => {
      if (event.sessionId !== sessionId) return;
      writeToTerm(event.data);
    });
    return () => {
      try {
        off?.();
      } catch {
        /* noop */
      }
    };
  }, [sessionId, writeToTerm]);

  // Re-fit when the active tab changes or the container resizes.
  useEffect(() => {
    if (!active) return;
    fit();
    try {
      terminalRef.current?.focus();
    } catch {
      /* noop */
    }
  }, [active, fit]);

  useEffect(() => {
    if (!active) return;
    const handler = () => fit();
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, [active, fit]);

  // Surface a quiet hint when the underlying session is exited.
  const statusBanner = useMemo(() => {
    if (session.status === 'exited') {
      const code = session.exitCode;
      return `Session exited${typeof code === 'number' ? ` (exit ${code})` : ''}.`;
    }
    if (session.status === 'error') {
      return `Session error${session.reason ? `: ${session.reason}` : ''}.`;
    }
    return null;
  }, [session.status, session.exitCode, session.reason]);

  return (
    <div
      data-testid={`terminal-pane-${taskId}`}
      data-active={active ? 'true' : 'false'}
      data-session-id={sessionId}
      className={`absolute inset-0 ${active ? '' : 'invisible pointer-events-none'}`}
    >
      <div ref={containerRef} className="absolute inset-0" />
      {statusBanner && (
        <div
          data-testid={`terminal-pane-banner-${taskId}`}
          className="absolute left-0 right-0 bottom-0 bg-gray-900/80 px-3 py-1 text-[11px] text-gray-400"
        >
          {statusBanner}
        </div>
      )}
    </div>
  );
}

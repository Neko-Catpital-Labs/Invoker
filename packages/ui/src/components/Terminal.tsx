/**
 * Terminal — xterm.js terminal for task output (read-only).
 *
 * Subscribes to window.invoker.onTaskOutput and renders stdout/stderr.
 * Double-clicking a task node opens an external OS terminal instead.
 *
 * When `collapsed` is true, xterm is not initialized (saving memory).
 * Re-expands cleanly by re-creating the terminal instance.
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Terminal as XTerminal } from 'xterm';

interface TerminalProps {
  taskId: string | null;
  /** When true, the terminal is hidden and xterm is not initialized. */
  collapsed?: boolean;
  /** Called when the terminal receives its first content (or resets to empty). */
  onContentChange?: (hasContent: boolean) => void;
}

export function Terminal({ taskId, collapsed = false, onContentChange }: TerminalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerminal | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const hasContentRef = useRef(false);
  const [xtermReady, setXtermReady] = useState(false);

  const setHasContent = useCallback(
    (value: boolean) => {
      if (hasContentRef.current !== value) {
        hasContentRef.current = value;
        onContentChange?.(value);
      }
    },
    [onContentChange],
  );

  // Initialize / dispose xterm based on collapsed state
  useEffect(() => {
    if (collapsed) {
      if (termRef.current) {
        termRef.current.dispose();
        termRef.current = null;
      }
      setXtermReady(false);
      return;
    }

    if (!containerRef.current) return;

    let term: XTerminal | null = null;
    let disposed = false;

    Promise.all([import('xterm'), import('xterm-addon-fit')]).then(
      ([xtermMod, fitMod]) => {
        if (disposed || !containerRef.current) return;

        term = new xtermMod.Terminal({
          cursorBlink: false,
          fontSize: 14,
          fontFamily: 'JetBrains Mono, Menlo, Monaco, monospace',
          theme: {
            background: '#1a1a2e',
            foreground: '#eaeaea',
            cursor: '#00ff88',
            cursorAccent: '#1a1a2e',
            selectionBackground: '#44475a',
            black: '#21222c',
            red: '#ff5555',
            green: '#50fa7b',
            yellow: '#f1fa8c',
            blue: '#6272a4',
            magenta: '#ff79c6',
            cyan: '#8be9fd',
            white: '#f8f8f2',
          },
          rows: 24,
          cols: 80,
        });

        const fitAddon = new fitMod.FitAddon();
        term.loadAddon(fitAddon);
        term.open(containerRef.current!);
        fitAddon.fit();

        termRef.current = term;
        setXtermReady(true);

        const handleResize = () => fitAddon.fit();
        window.addEventListener('resize', handleResize);

        (containerRef.current as HTMLDivElement & { _resizeCleanup?: () => void })._resizeCleanup =
          () => window.removeEventListener('resize', handleResize);
      },
    );

    return () => {
      disposed = true;
      setXtermReady(false);
      if (term) {
        term.dispose();
        termRef.current = null;
      }
    };
  }, [collapsed]);

  // Subscribe to task output / activity log when taskId or xterm readiness changes
  useEffect(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }

    setHasContent(false);

    const term = termRef.current;
    if (!term || collapsed || !xtermReady) return;

    term.clear();

    if (!taskId) return;

    if (typeof window === 'undefined' || !window.invoker) return;

    if (taskId === '__system__') {
      term.writeln('\x1b[36mSystem Activity Log\x1b[0m');
      term.writeln('');
      setHasContent(true);

      const writeEntries = (entries: Array<{ level: string; timestamp: string; source: string; message: string }>) => {
        for (const entry of entries) {
          const color = entry.level === 'error' ? '\x1b[31m' : entry.level === 'warn' ? '\x1b[33m' : '\x1b[90m';
          const ts = entry.timestamp.replace('T', ' ').slice(0, 19);
          term.writeln(`${color}${ts}\x1b[0m [\x1b[36m${entry.source}\x1b[0m] ${entry.message}`);
        }
      };

      // Fetch historical entries first, then subscribe for new ones
      window.invoker.getActivityLogs().then(writeEntries).catch(() => {});
      unsubRef.current = window.invoker.onActivityLog(writeEntries);
    } else {
      term.writeln(`\x1b[32mViewing output for: ${taskId}\x1b[0m`);
      term.writeln('');
      setHasContent(true);

      unsubRef.current = window.invoker.onTaskOutput((data) => {
        if (data.taskId === taskId) {
          term.write(data.data);
        }
      });
    }

    return () => {
      if (unsubRef.current) {
        unsubRef.current();
        unsubRef.current = null;
      }
    };
  }, [taskId, collapsed, xtermReady, setHasContent]);

  if (collapsed) return null;

  return (
    <div className="h-full w-full flex flex-col bg-[#1a1a2e] rounded-lg overflow-hidden">
      <div ref={containerRef} className="flex-1 p-2" />
    </div>
  );
}

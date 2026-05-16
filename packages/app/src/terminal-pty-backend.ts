/**
 * PTY backend abstraction for embedded task terminals.
 *
 * The default backend dynamically loads `node-pty` (the real terminal emulator
 * Electron apps ship with) and falls back to a `child_process.spawn` shim when
 * the native module is unavailable — for example in `vitest` runs that execute
 * under system Node without the Electron rebuild. Tests can also inject their
 * own backend factory to keep behaviour deterministic.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createRequire } from 'node:module';

export interface SpawnTerminalOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface TerminalProcess {
  readonly pid?: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(cb: (data: string) => void): () => void;
  onExit(cb: (exitCode: number | null, signal?: string | null) => void): () => void;
}

export type TerminalBackend = (opts: SpawnTerminalOptions) => TerminalProcess;

interface NodePtyModule {
  spawn(
    command: string,
    args: string[],
    options: {
      cwd?: string;
      env?: Record<string, string>;
      cols?: number;
      rows?: number;
      name?: string;
    },
  ): {
    pid: number;
    onData(cb: (data: string) => void): { dispose(): void };
    onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(signal?: string): void;
  };
}

let cachedNodePty: NodePtyModule | null | undefined;

/**
 * Attempt to load node-pty lazily. Returns null on platforms without the
 * native module — the caller then falls back to the child_process shim.
 */
export function tryLoadNodePty(): NodePtyModule | null {
  if (cachedNodePty !== undefined) return cachedNodePty;
  try {
    const req = createRequire(import.meta.url);
    cachedNodePty = req('node-pty') as NodePtyModule;
  } catch {
    cachedNodePty = null;
  }
  return cachedNodePty;
}

/** Reset the cached node-pty module — exposed for tests only. */
export function resetNodePtyCacheForTests(): void {
  cachedNodePty = undefined;
}

function makeNodePtyProcess(pty: NodePtyModule, opts: SpawnTerminalOptions): TerminalProcess {
  const proc = pty.spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols ?? 80,
    rows: opts.rows ?? 24,
    name: 'xterm-256color',
  });
  return {
    pid: proc.pid,
    write: (data) => proc.write(data),
    resize: (cols, rows) => proc.resize(cols, rows),
    kill: (signal) => proc.kill(signal),
    onData: (cb) => {
      const sub = proc.onData(cb);
      return () => sub.dispose();
    },
    onExit: (cb) => {
      const sub = proc.onExit((e) => {
        const sigName = typeof e.signal === 'number' ? String(e.signal) : undefined;
        cb(e.exitCode ?? null, sigName);
      });
      return () => sub.dispose();
    },
  };
}

function makeChildProcessShim(opts: SpawnTerminalOptions): TerminalProcess {
  const child: ChildProcessWithoutNullStreams = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;

  const dataListeners = new Set<(data: string) => void>();
  const exitListeners = new Set<(code: number | null, signal?: string | null) => void>();

  const emitData = (chunk: Buffer | string) => {
    const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    for (const l of dataListeners) l(s);
  };
  child.stdout?.on('data', emitData);
  child.stderr?.on('data', emitData);
  child.on('exit', (code, signal) => {
    for (const l of exitListeners) l(code, signal ?? undefined);
  });
  child.on('error', (err) => {
    for (const l of dataListeners) l(`\r\n[backend error: ${err.message}]\r\n`);
    for (const l of exitListeners) l(null, undefined);
  });

  return {
    pid: child.pid,
    write: (data) => {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(data);
    },
    resize: () => {
      // child_process shim doesn't support TTY resize — no-op.
    },
    kill: (signal) => {
      try {
        child.kill((signal as NodeJS.Signals | undefined) ?? 'SIGTERM');
      } catch {
        /* already exited */
      }
    },
    onData: (cb) => {
      dataListeners.add(cb);
      return () => {
        dataListeners.delete(cb);
      };
    },
    onExit: (cb) => {
      exitListeners.add(cb);
      return () => {
        exitListeners.delete(cb);
      };
    },
  };
}

/**
 * Default backend: prefers node-pty, falls back to child_process.spawn when
 * the native binding is not installed (e.g. in vitest runs that don't rebuild
 * native modules against the system Node ABI).
 */
export const defaultTerminalBackend: TerminalBackend = (opts) => {
  const pty = tryLoadNodePty();
  if (pty) return makeNodePtyProcess(pty, opts);
  return makeChildProcessShim(opts);
};

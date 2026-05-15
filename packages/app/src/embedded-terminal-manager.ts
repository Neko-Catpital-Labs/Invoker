/**
 * Embedded task terminal sessions — Electron main-process backend.
 *
 * GUI open-terminal requests route through this manager so users stay
 * inside Invoker instead of getting an external OS terminal window.
 * Headless mode continues to use `openExternalTerminalForTask` so its
 * workspace-mutation safety contract is unchanged.
 *
 * The manager keeps one session per task. Each session is one of:
 *
 *   - `attached` — task has a live executor handle; output streams from
 *     `executor.onOutput` and input is forwarded via `executor.sendInput`.
 *   - `pty`      — task is no longer running; a PTY is spawned using the
 *     persisted terminal spec (`getRestoredTerminalSpec`) so resume
 *     commands (claude --resume / codex resume) and worktree checkout
 *     scripts run with full TTY semantics.
 *
 * PTY backends are pluggable so tests can drive deterministic fakes; the
 * production factory lazy-loads `node-pty` and falls back to a stdout/stdin
 * `child_process` backend when no native PTY library is available (useful
 * in development environments where node-pty cannot be rebuilt).
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import type { Logger, EmbeddedTerminalSession, TerminalExitEvent, TerminalOutputEvent, TerminalOpenResult } from '@invoker/contracts';
import {
  getEffectivePath,
  type AgentRegistry,
  type Executor,
  type ExecutorHandle,
  type ExecutorRegistry,
  type Unsubscribe,
} from '@invoker/execution-engine';
import { resolveTerminalSpecForTask, type OpenTerminalPersistence } from './open-terminal-for-task.js';

// ── PTY backend abstraction ──────────────────────────────────

export interface PtySpawnOptions {
  command: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyHandle {
  /** Subscribe to PTY output. Returns an unsubscribe. */
  onData(cb: (chunk: string) => void): Unsubscribe;
  /** Subscribe to PTY exit. Returns an unsubscribe. */
  onExit(cb: (info: { exitCode: number; signal?: string }) => void): Unsubscribe;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtyBackend {
  spawn(opts: PtySpawnOptions): PtyHandle;
}

// ── Manager events ───────────────────────────────────────────

export interface EmbeddedTerminalManagerEvents {
  output: (evt: TerminalOutputEvent) => void;
  exit: (evt: TerminalExitEvent) => void;
}

export interface EmbeddedTerminalManagerOptions {
  persistence: OpenTerminalPersistence;
  executorRegistry: ExecutorRegistry;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  /** Returns the live executor handle for a task, when one exists. */
  getActiveHandle: (taskId: string) => { handle: ExecutorHandle; executor: Executor } | undefined;
  /** PTY backend used when spawning a process for a non-running task. */
  ptyBackend: PtyBackend;
  logger?: Logger;
}

// ── Internal session ─────────────────────────────────────────

interface AttachedInternalSession {
  kind: 'attached';
  descriptor: EmbeddedTerminalSession;
  unsubscribeOutput: Unsubscribe;
  unsubscribeComplete: Unsubscribe;
  executor: Executor;
  handle: ExecutorHandle;
}

interface PtyInternalSession {
  kind: 'pty';
  descriptor: EmbeddedTerminalSession;
  pty: PtyHandle;
  unsubscribeData: Unsubscribe;
  unsubscribeExit: Unsubscribe;
}

type InternalSession = AttachedInternalSession | PtyInternalSession;

// ── Manager ──────────────────────────────────────────────────

export class EmbeddedTerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, InternalSession>();
  private readonly taskToSession = new Map<string, string>();
  private readonly opts: EmbeddedTerminalManagerOptions;
  private disposed = false;

  constructor(opts: EmbeddedTerminalManagerOptions) {
    super();
    this.opts = opts;
  }

  /**
   * Open the existing embedded session for `taskId`, or create one.
   * The same `sessionId` is returned for repeated calls on the same task.
   */
  openOrSelectSession(taskId: string): TerminalOpenResult {
    if (this.disposed) {
      return { opened: false, reason: 'Embedded terminal manager has been disposed.' };
    }

    const existingId = this.taskToSession.get(taskId);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && !existing.descriptor.exited) {
        this.opts.logger?.info(
          `reusing existing session ${existingId} (mode=${existing.descriptor.mode}) for task=${taskId}`,
          { module: 'embedded-terminal' },
        );
        return { opened: true, session: { ...existing.descriptor } };
      }
      // Stale (exited) entry — drop and continue.
      if (existing) this.disposeSession(existingId);
      this.taskToSession.delete(taskId);
    }

    // Try attached mode first when the task has a live executor handle.
    const active = this.opts.getActiveHandle(taskId);
    if (active) {
      return this.openAttachedSession(taskId, active);
    }

    // Fall back to PTY mode using the persisted terminal spec.
    return this.openPtySession(taskId);
  }

  /** Snapshot of all known sessions. */
  listSessions(): EmbeddedTerminalSession[] {
    return [...this.sessions.values()].map((s) => ({ ...s.descriptor }));
  }

  /** Return descriptor for a known session, or null if missing. */
  selectSession(sessionId: string): EmbeddedTerminalSession | null {
    const entry = this.sessions.get(sessionId);
    return entry ? { ...entry.descriptor } : null;
  }

  /** Forward input bytes to the underlying handle (PTY or executor). */
  writeInput(sessionId: string, data: string): { ok: boolean; reason?: string } {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, reason: `Unknown session "${sessionId}"` };
    if (entry.descriptor.exited) return { ok: false, reason: `Session "${sessionId}" has exited` };
    try {
      if (entry.kind === 'pty') {
        entry.pty.write(data);
      } else {
        entry.executor.sendInput(entry.handle, data);
      }
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logger?.info(`writeInput failed sessionId=${sessionId}: ${reason}`, { module: 'embedded-terminal' });
      return { ok: false, reason };
    }
  }

  /** Resize the PTY; attached sessions have no PTY to resize so this is a no-op. */
  resize(sessionId: string, cols: number, rows: number): { ok: boolean; reason?: string } {
    const entry = this.sessions.get(sessionId);
    if (!entry) return { ok: false, reason: `Unknown session "${sessionId}"` };
    if (entry.descriptor.exited) return { ok: false, reason: `Session "${sessionId}" has exited` };
    if (entry.kind === 'pty') {
      try {
        entry.pty.resize(cols, rows);
        return { ok: true };
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason };
      }
    }
    return { ok: true };
  }

  /** Tear down a session. Does NOT kill the underlying task for attached mode. */
  closeSession(sessionId: string): { closed: boolean } {
    if (!this.sessions.has(sessionId)) return { closed: false };
    this.disposeSession(sessionId);
    return { closed: true };
  }

  /** Tear down all sessions; call on app shutdown. */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const sessionId of [...this.sessions.keys()]) {
      this.disposeSession(sessionId);
    }
    this.removeAllListeners();
  }

  // ── Internal: attached mode ──────────────────────────────

  private openAttachedSession(
    taskId: string,
    active: { handle: ExecutorHandle; executor: Executor },
  ): TerminalOpenResult {
    const sessionId = randomUUID();
    const descriptor: EmbeddedTerminalSession = {
      sessionId,
      taskId,
      mode: 'attached',
      cwd: active.handle.workspacePath,
      exited: false,
      createdAt: new Date().toISOString(),
    };

    const unsubscribeOutput = active.executor.onOutput(active.handle, (chunk) => {
      this.emit('output', { sessionId, taskId, data: chunk } satisfies TerminalOutputEvent);
    });
    const unsubscribeComplete = active.executor.onComplete(active.handle, (response) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      entry.descriptor.exited = true;
      const code = typeof response?.outputs?.exitCode === 'number' ? response.outputs.exitCode : 0;
      entry.descriptor.exitCode = code;
      this.emit('exit', { sessionId, taskId, exitCode: code } satisfies TerminalExitEvent);
    });

    const internal: AttachedInternalSession = {
      kind: 'attached',
      descriptor,
      unsubscribeOutput,
      unsubscribeComplete,
      executor: active.executor,
      handle: active.handle,
    };
    this.sessions.set(sessionId, internal);
    this.taskToSession.set(taskId, sessionId);
    this.opts.logger?.info(
      `opened attached session ${sessionId} for running task=${taskId} executor=${active.executor.type}`,
      { module: 'embedded-terminal' },
    );
    return { opened: true, session: { ...descriptor } };
  }

  // ── Internal: PTY mode ───────────────────────────────────

  private openPtySession(taskId: string): TerminalOpenResult {
    const resolution = resolveTerminalSpecForTask({
      taskId,
      persistence: this.opts.persistence,
      executorRegistry: this.opts.executorRegistry,
      executionAgentRegistry: this.opts.executionAgentRegistry,
      repoRoot: this.opts.repoRoot,
      logger: this.opts.logger,
    });
    if (!resolution.ok) {
      return { opened: false, reason: resolution.reason };
    }
    if (resolution.status === 'running' || resolution.status === 'fixing_with_ai') {
      // Task is marked running but no active handle is registered. Refuse rather
      // than spawn a duplicate session; the orchestrator should be the source of
      // truth for live output.
      return {
        opened: false,
        reason:
          'Task is still running but the executor handle is not available to attach. ' +
          'Wait for output to flush, or restart the orchestrator process.',
      };
    }

    const { spec, cwd } = resolution;
    const command = spec.command ?? defaultInteractiveShell();
    const args = spec.command ? spec.args ?? [] : [];
    const env = buildPtyEnv();

    let pty: PtyHandle;
    try {
      pty = this.opts.ptyBackend.spawn({ command, args, cwd, env, cols: 80, rows: 24 });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.opts.logger?.info(`PTY spawn failed for task=${taskId}: ${reason}`, { module: 'embedded-terminal' });
      return { opened: false, reason: `Failed to spawn PTY: ${reason}` };
    }

    const sessionId = randomUUID();
    const descriptor: EmbeddedTerminalSession = {
      sessionId,
      taskId,
      mode: 'pty',
      cwd,
      command,
      args,
      exited: false,
      createdAt: new Date().toISOString(),
    };

    const unsubscribeData = pty.onData((chunk) => {
      this.emit('output', { sessionId, taskId, data: chunk } satisfies TerminalOutputEvent);
    });
    const unsubscribeExit = pty.onExit(({ exitCode, signal }) => {
      const entry = this.sessions.get(sessionId);
      if (!entry) return;
      entry.descriptor.exited = true;
      entry.descriptor.exitCode = exitCode;
      this.emit('exit', { sessionId, taskId, exitCode, signal } satisfies TerminalExitEvent);
    });

    const internal: PtyInternalSession = {
      kind: 'pty',
      descriptor,
      pty,
      unsubscribeData,
      unsubscribeExit,
    };
    this.sessions.set(sessionId, internal);
    this.taskToSession.set(taskId, sessionId);
    this.opts.logger?.info(
      `opened pty session ${sessionId} for task=${taskId} cwd=${cwd} command=${command}`,
      { module: 'embedded-terminal' },
    );
    return { opened: true, session: { ...descriptor } };
  }

  // ── Internal: disposal ───────────────────────────────────

  private disposeSession(sessionId: string): void {
    const entry = this.sessions.get(sessionId);
    if (!entry) return;
    this.sessions.delete(sessionId);
    if (this.taskToSession.get(entry.descriptor.taskId) === sessionId) {
      this.taskToSession.delete(entry.descriptor.taskId);
    }
    try {
      if (entry.kind === 'pty') {
        entry.unsubscribeData();
        entry.unsubscribeExit();
        if (!entry.descriptor.exited) entry.pty.kill();
      } else {
        entry.unsubscribeOutput();
        entry.unsubscribeComplete();
      }
    } catch (err) {
      this.opts.logger?.info(
        `disposeSession ${sessionId} cleanup error: ${err instanceof Error ? err.message : String(err)}`,
        { module: 'embedded-terminal' },
      );
    }
  }
}

// ── PTY env / shell helpers ──────────────────────────────────

function defaultInteractiveShell(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

function buildPtyEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  const keep = [
    'HOME', 'USER', 'LOGNAME', 'SHELL', 'LANG', 'LC_ALL', 'LC_CTYPE',
    'TERM', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
    'ANTHROPIC_API_KEY', 'CLAUDE_API_KEY', 'OPENAI_API_KEY',
  ];
  for (const k of keep) {
    if (process.env[k]) env[k] = process.env[k]!;
  }
  env.PATH = getEffectivePath();
  if (!env.TERM) env.TERM = 'xterm-256color';
  return env;
}

// ── Default PTY backend ──────────────────────────────────────

/**
 * Best-effort PTY backend. Tries `node-pty` first (the production choice for
 * Electron desktop builds) and falls back to a plain `child_process.spawn`
 * adapter that wires stdin/stdout/stderr as a non-PTY stream. The fallback
 * is useful in development environments where the native module is missing.
 *
 * Tests should NOT use this; they should inject a deterministic backend.
 */
export function createDefaultPtyBackend(logger?: Logger): PtyBackend {
  const native = tryLoadNodePtyBackend(logger);
  if (native) return native;
  logger?.info(
    'node-pty unavailable, falling back to child_process backend (no TTY semantics)',
    { module: 'embedded-terminal' },
  );
  return createChildProcessFallbackBackend();
}

function tryLoadNodePtyBackend(logger?: Logger): PtyBackend | null {
  try {
    // Indirect require so bundlers (tsup) don't try to resolve at build time.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const req: NodeRequire = (eval('require') as NodeRequire);
    const pty = req('node-pty') as {
      spawn: (
        file: string,
        args: string[],
        opts: { name?: string; cols?: number; rows?: number; cwd?: string; env?: NodeJS.ProcessEnv },
      ) => {
        onData(cb: (chunk: string) => void): { dispose(): void };
        onExit(cb: (e: { exitCode: number; signal?: number }) => void): { dispose(): void };
        write(data: string): void;
        resize(cols: number, rows: number): void;
        kill(signal?: string): void;
      };
    };
    return {
      spawn(opts) {
        const proc = pty.spawn(opts.command, opts.args, {
          name: 'xterm-256color',
          cols: opts.cols ?? 80,
          rows: opts.rows ?? 24,
          cwd: opts.cwd,
          env: opts.env as NodeJS.ProcessEnv,
        });
        return {
          onData(cb) { const d = proc.onData(cb); return () => d.dispose(); },
          onExit(cb) {
            const d = proc.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal != null ? String(e.signal) : undefined }));
            return () => d.dispose();
          },
          write(data) { proc.write(data); },
          resize(cols, rows) { proc.resize(cols, rows); },
          kill(signal) { proc.kill(signal); },
        };
      },
    };
  } catch (err) {
    logger?.info(
      `node-pty load failed: ${err instanceof Error ? err.message : String(err)}`,
      { module: 'embedded-terminal' },
    );
    return null;
  }
}

/**
 * Non-PTY fallback. Spawns the command and pipes stdout/stderr to data
 * listeners. Sufficient for showing output / sending newline-delimited
 * input but without TTY semantics (no signals, no resize, no echo).
 */
function createChildProcessFallbackBackend(): PtyBackend {
  return {
    spawn(opts) {
      const child: ChildProcess = spawn(opts.command, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const dataListeners = new Set<(chunk: string) => void>();
      const exitListeners = new Set<(e: { exitCode: number; signal?: string }) => void>();
      const fanOut = (chunk: Buffer | string) => {
        const s = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
        for (const cb of dataListeners) cb(s);
      };
      child.stdout?.on('data', fanOut);
      child.stderr?.on('data', fanOut);
      child.on('exit', (code, signal) => {
        const evt = { exitCode: code ?? 0, signal: signal ?? undefined };
        for (const cb of exitListeners) cb(evt);
      });
      return {
        onData(cb) { dataListeners.add(cb); return () => dataListeners.delete(cb); },
        onExit(cb) { exitListeners.add(cb); return () => exitListeners.delete(cb); },
        write(data) { child.stdin?.write(data); },
        resize() { /* no-op for non-PTY backend */ },
        kill(signal) { child.kill(signal as NodeJS.Signals | undefined); },
      };
    },
  };
}

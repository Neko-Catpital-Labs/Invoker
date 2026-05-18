/**
 * Embedded terminal manager (main process).
 *
 * Owns terminal sessions for the GUI: one logical session per task. When the
 * caller asks to open a terminal for a task we either reuse an existing live
 * session or spawn a new one. Two backing modes:
 *
 *  - `pty`      — main process spawned a fresh pseudoterminal using the
 *                 {@link TerminalSpec} resolved from persisted task metadata.
 *                 This is the typical path for completed/failed tasks where
 *                 we restore the workspace and let the user inspect it.
 *  - `attached` — the session is wired to a live executor handle. Output is
 *                 fanned in from `executor.onOutput` and input is forwarded
 *                 through `executor.sendInput`. Used for tasks that are
 *                 still running (status `running` / `fixing_with_ai`) where
 *                 we cannot safely launch a competing shell against the
 *                 same workspace.
 *
 * The manager emits two events that the IPC layer forwards to the renderer:
 *  - `output { sessionId, taskId, data }`
 *  - `exit   { sessionId, taskId, exitCode? }`
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import * as nodePty from 'node-pty';
import type {
  TerminalSessionDescriptor,
  TerminalOutputEvent,
  TerminalExitEvent,
} from '@invoker/contracts';
import type { Executor, ExecutorHandle, TerminalSpec } from '@invoker/execution-engine';

/** Factory used to spawn PTYs. Exposed for deterministic tests. */
export type PtySpawnFn = (
  command: string,
  args: readonly string[],
  options: nodePty.IPtyForkOptions | nodePty.IWindowsPtyForkOptions,
) => nodePty.IPty;

/** Optional attach handle pair routing a session through a live executor. */
export interface AttachContext {
  handle: ExecutorHandle;
  executor: Executor;
}

export interface OpenSessionOptions {
  taskId: string;
  spec: TerminalSpec;
  cwd: string;
  agentName?: string;
  /** When provided, the session attaches to the running executor rather than spawning a child. */
  attach?: AttachContext;
}

interface BaseSessionState {
  sessionId: string;
  taskId: string;
  spec: TerminalSpec;
  cwd: string;
  agentName?: string;
  createdAt: string;
  status: 'running' | 'exited';
  exitCode?: number;
}

interface PtySessionState extends BaseSessionState {
  mode: 'pty';
  pty: nodePty.IPty;
  disposeData: nodePty.IDisposable;
  disposeExit: nodePty.IDisposable;
}

interface AttachedSessionState extends BaseSessionState {
  mode: 'attached';
  attach: AttachContext;
  unsubscribeOutput: () => void;
}

type SessionState = PtySessionState | AttachedSessionState;

export interface EmbeddedTerminalManagerOptions {
  /** Override node-pty.spawn (used by tests). */
  ptySpawnFn?: PtySpawnFn;
  /** Default shell for PTY sessions when the spec has no command. */
  defaultShell?: string;
}

function describeSession(state: SessionState): TerminalSessionDescriptor {
  return {
    sessionId: state.sessionId,
    taskId: state.taskId,
    status: state.status,
    exitCode: state.exitCode,
    cwd: state.cwd,
    command: state.spec.command,
    args: state.spec.args,
    mode: state.mode,
    backend: state.mode,
    agentName: state.agentName,
    attached: state.mode === 'attached',
    createdAt: state.createdAt,
  };
}

export class EmbeddedTerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly taskIndex = new Map<string, string>();
  private readonly ptySpawnFn: PtySpawnFn;
  private readonly defaultShell: string;

  constructor(options: EmbeddedTerminalManagerOptions = {}) {
    super();
    this.ptySpawnFn = options.ptySpawnFn ?? ((command, args, spawnOptions) => (
      nodePty.spawn(command, [...args], spawnOptions)
    ));
    this.defaultShell =
      options.defaultShell ?? (process.platform === 'darwin' ? 'zsh' : 'bash');
  }

  /**
   * Open a new embedded session for the task, or return the existing live one.
   * Reusing by taskId is what the spec calls "select" — the channel name is
   * intentionally `open-terminal` for both paths.
   */
  openOrReuse(opts: OpenSessionOptions): TerminalSessionDescriptor {
    const existingId = this.taskIndex.get(opts.taskId);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.status === 'running') {
        return describeSession(existing);
      }
      // Stale entry — clean up before re-opening.
      this.taskIndex.delete(opts.taskId);
      if (existing) this.sessions.delete(existingId);
    }

    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const base = {
      sessionId,
      taskId: opts.taskId,
      spec: opts.spec,
      cwd: opts.cwd,
      agentName: opts.agentName,
      createdAt,
      status: 'running' as const,
    };

    let state: SessionState;
    if (opts.attach) {
      const unsubscribe = opts.attach.executor.onOutput(opts.attach.handle, (data) => {
        this.emitOutput(sessionId, opts.taskId, data);
      });
      state = {
        ...base,
        mode: 'attached',
        attach: opts.attach,
        unsubscribeOutput: unsubscribe,
      };
    } else {
      const pty = this.spawnPty(opts.spec, opts.cwd);
      state = {
        ...base,
        mode: 'pty',
        pty,
        disposeData: pty.onData((data) => {
          this.emitOutput(sessionId, opts.taskId, data);
        }),
        disposeExit: pty.onExit(({ exitCode }) => {
          this.finalizeSession(state, exitCode);
        }),
      };
    }

    this.sessions.set(sessionId, state);
    this.taskIndex.set(opts.taskId, sessionId);
    return describeSession(state);
  }

  list(): TerminalSessionDescriptor[] {
    return Array.from(this.sessions.values()).map(describeSession);
  }

  get(sessionId: string): TerminalSessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    return state ? describeSession(state) : undefined;
  }

  /**
   * Write user input to a session.
   * Returns `{ ok: false, reason }` if the session is gone or the backing process refuses input.
   */
  write(sessionId: string, data: string): { ok: boolean; reason?: string } {
    const state = this.sessions.get(sessionId);
    if (!state) return { ok: false, reason: `Unknown session "${sessionId}".` };
    if (state.status !== 'running') {
      return { ok: false, reason: `Session "${sessionId}" has already exited.` };
    }
    if (state.mode === 'attached') {
      try {
        state.attach.executor.sendInput(state.attach.handle, data);
        return { ok: true };
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) };
      }
    }
    try {
      state.pty.write(data);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  resize(sessionId: string, cols: number, rows: number): { ok: boolean; reason?: string } {
    const state = this.sessions.get(sessionId);
    if (!state) return { ok: false, reason: `Unknown session "${sessionId}".` };
    if (state.status !== 'running') {
      return { ok: false, reason: `Session "${sessionId}" has already exited.` };
    }
    if (state.mode === 'attached') return { ok: true };
    try {
      state.pty.resize(cols, rows);
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  }

  close(sessionId: string): { ok: boolean; reason?: string } {
    const state = this.sessions.get(sessionId);
    if (!state) return { ok: false, reason: `Unknown session "${sessionId}".` };
    this.finalizeSession(state, undefined, true);
    return { ok: true };
  }

  /** Tear down all live sessions; called from `before-quit`. */
  closeAll(): void {
    for (const state of Array.from(this.sessions.values())) {
      this.finalizeSession(state, undefined, true);
    }
  }

  private spawnPty(spec: TerminalSpec, cwd: string): nodePty.IPty {
    const command = spec.command ?? this.defaultShell;
    const args = spec.command ? spec.args ?? [] : [];
    return this.ptySpawnFn(command, args, {
      cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
    });
  }

  private finalizeSession(state: SessionState, exitCode: number | undefined, remove = false): void {
    if (state.status === 'exited') {
      if (remove) this.sessions.delete(state.sessionId);
      return;
    }
    state.status = 'exited';
    state.exitCode = exitCode;

    if (state.mode === 'pty') {
      try {
        state.disposeData.dispose();
        state.disposeExit.dispose();
      } catch {
        /* already disposed */
      }
      try {
        state.pty.kill();
      } catch {
        /* already dead */
      }
    } else {
      try {
        state.unsubscribeOutput();
      } catch {
        /* unsubscribe is best-effort */
      }
    }

    if (this.taskIndex.get(state.taskId) === state.sessionId) {
      this.taskIndex.delete(state.taskId);
    }
    if (remove) {
      this.sessions.delete(state.sessionId);
    }

    const payload: TerminalExitEvent = {
      sessionId: state.sessionId,
      taskId: state.taskId,
      exitCode,
    };
    this.emit('exit', payload);
  }

  private emitOutput(sessionId: string, taskId: string, data: string): void {
    const payload: TerminalOutputEvent = { sessionId, taskId, data };
    this.emit('output', payload);
  }
}

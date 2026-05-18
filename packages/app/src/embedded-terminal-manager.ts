/**
 * Embedded terminal manager (main process).
 *
 * Owns terminal sessions for the GUI: one logical session per task. When the
 * caller asks to open a terminal for a task we either reuse an existing live
 * session or spawn a new one. Two backing modes:
 *
 *  - `spawn`    — main process spawned a fresh child shell using the
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
import { spawn as nodePtySpawn, type IPty, type IPtyForkOptions } from 'node-pty';
import type {
  TerminalSessionDescriptor,
  TerminalOutputEvent,
  TerminalExitEvent,
} from '@invoker/contracts';
import type { Executor, ExecutorHandle, TerminalSpec } from '@invoker/execution-engine';

/** Factory used to spawn a pseudoterminal for `spawn`-mode sessions. */
export type PtySpawnFn = (
  command: string,
  args: readonly string[],
  options: IPtyForkOptions,
) => IPty;

/** Optional attach handle pair routing a session through a live executor. */
export interface AttachContext {
  handle: ExecutorHandle;
  executor: Executor;
}

export interface OpenSessionOptions {
  taskId: string;
  spec: TerminalSpec;
  cwd: string;
  /** When provided, the session attaches to the running executor rather than spawning a child. */
  attach?: AttachContext;
}

interface BaseSessionState {
  sessionId: string;
  taskId: string;
  targetKey: string;
  spec: TerminalSpec;
  cwd: string;
  createdAt: string;
  status: 'running' | 'exited';
  exitCode?: number;
}

interface SpawnSessionState extends BaseSessionState {
  mode: 'spawn';
  pty: IPty;
  disposeData: () => void;
  disposeExit: () => void;
}

interface AttachedSessionState extends BaseSessionState {
  mode: 'attached';
  attach: AttachContext;
  unsubscribeOutput: () => void;
}

type SessionState = SpawnSessionState | AttachedSessionState;

export interface EmbeddedTerminalManagerOptions {
  /** Override the node-pty spawn function (used by tests). */
  ptySpawnFn?: PtySpawnFn;
  /** Default shell for `spawn`-mode sessions when the spec has no command. */
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
    attached: state.mode === 'attached',
    createdAt: state.createdAt,
  };
}

export class EmbeddedTerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly targetIndex = new Map<string, string>();
  private readonly ptySpawnFn: PtySpawnFn;
  private readonly defaultShell: string;

  constructor(options: EmbeddedTerminalManagerOptions = {}) {
    super();
    this.ptySpawnFn = options.ptySpawnFn ?? (nodePtySpawn as unknown as PtySpawnFn);
    this.defaultShell =
      options.defaultShell ?? (process.platform === 'darwin' ? 'zsh' : 'bash');
  }

  /**
   * Open a new embedded session for the resolved terminal target, or return
   * the existing live one. A changed attempt/session/workspace/branch resolves
   * to a different target and therefore gets a distinct tab.
   */
  openOrReuse(opts: OpenSessionOptions): TerminalSessionDescriptor {
    const targetKey = buildTargetKey(opts);
    const existingId = this.targetIndex.get(targetKey);
    if (existingId) {
      const existing = this.sessions.get(existingId);
      if (existing && existing.status === 'running') {
        return describeSession(existing);
      }
      // Stale entry — clean up before re-opening.
      this.targetIndex.delete(targetKey);
      if (existing) this.sessions.delete(existingId);
    }

    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const base = {
      sessionId,
      taskId: opts.taskId,
      targetKey,
      spec: opts.spec,
      cwd: opts.cwd,
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
      state = {
        ...base,
        mode: 'spawn',
        pty: this.spawnPty(opts.spec, opts.cwd),
        disposeData: () => {},
        disposeExit: () => {},
      };
      this.wireSpawnedPty(state);
    }

    this.sessions.set(sessionId, state);
    this.targetIndex.set(targetKey, sessionId);
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
    this.finalizeSession(state, undefined);
    return { ok: true };
  }

  /** Tear down all live sessions; called from `before-quit`. */
  closeAll(): void {
    for (const state of Array.from(this.sessions.values())) {
      this.finalizeSession(state, undefined);
    }
  }

  private spawnPty(spec: TerminalSpec, cwd: string): IPty {
    const command = spec.command ?? this.defaultShell;
    const args = spec.command ? spec.args ?? [] : [];
    const options: IPtyForkOptions = {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
    };
    return this.ptySpawnFn(command, args, options);
  }

  private wireSpawnedPty(state: SpawnSessionState): void {
    const { pty, sessionId, taskId } = state;
    const dataDisposable = pty.onData((data) => {
      this.emitOutput(sessionId, taskId, data);
    });
    state.disposeData = () => dataDisposable.dispose();
    const exitDisposable = pty.onExit(({ exitCode }) => {
      this.finalizeSession(state, exitCode);
    });
    state.disposeExit = () => exitDisposable.dispose();
  }

  private finalizeSession(state: SessionState, exitCode: number | undefined): void {
    if (state.status === 'exited') return;
    state.status = 'exited';
    state.exitCode = exitCode;

    if (state.mode === 'spawn') {
      try {
        state.disposeData();
        state.disposeExit();
      } catch {
        /* listener disposal is best-effort */
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

    if (this.targetIndex.get(state.targetKey) === state.sessionId) {
      this.targetIndex.delete(state.targetKey);
    }
    this.sessions.delete(state.sessionId);

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

function buildTargetKey(opts: OpenSessionOptions): string {
  return JSON.stringify({
    taskId: opts.taskId,
    cwd: opts.cwd,
    command: opts.spec.command ?? null,
    args: opts.spec.args ?? [],
    linuxTerminalTail: opts.spec.linuxTerminalTail ?? null,
    attach: opts.attach
      ? {
          executionId: opts.attach.handle.executionId,
          agentSessionId: opts.attach.handle.agentSessionId ?? null,
          containerId: opts.attach.handle.containerId ?? null,
          workspacePath: opts.attach.handle.workspacePath ?? null,
          branch: opts.attach.handle.branch ?? null,
        }
      : null,
  });
}

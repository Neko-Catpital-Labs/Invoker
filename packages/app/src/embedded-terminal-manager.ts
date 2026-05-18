/**
 * Embedded terminal manager (main process).
 *
 * Owns GUI terminal sessions and delegates spawned sessions to a backend.
 * Headless open-terminal is intentionally not routed through this manager; it
 * continues to use the external OS terminal launcher.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import type {
  TerminalSessionDescriptor,
  TerminalOutputEvent,
  TerminalExitEvent,
} from '@invoker/contracts';
import type { Executor, ExecutorHandle, TerminalSpec } from '@invoker/execution-engine';

export type EmbeddedTerminalBackendName = 'bash';

/** Factory used by the default bash/pipe backend. Tests can supply a fake. */
export type BashSpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface SpawnedTerminalProcess {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  close(): void;
}

export interface EmbeddedTerminalBackend {
  readonly name: EmbeddedTerminalBackendName;
  spawn(opts: {
    spec: TerminalSpec;
    cwd: string;
    defaultShell: string;
    emitOutput: (data: string) => void;
    emitExit: (exitCode?: number) => void;
  }): SpawnedTerminalProcess;
}

export interface BashTerminalBackendOptions {
  /** Override the child_process.spawn function for this Bash backend instance. */
  spawnFn?: BashSpawnFn;
}

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
  backend: EmbeddedTerminalBackendName;
  process: SpawnedTerminalProcess;
}

interface AttachedSessionState extends BaseSessionState {
  mode: 'attached';
  attach: AttachContext;
  unsubscribeOutput: () => void;
}

type SessionState = SpawnSessionState | AttachedSessionState;

export interface EmbeddedTerminalManagerOptions {
  /** Single backend used for GUI spawned sessions. Defaults to the Bash/pipe backend. */
  backend?: EmbeddedTerminalBackend;
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

class BashTerminalBackend implements EmbeddedTerminalBackend {
  readonly name = 'bash' as const;
  private readonly spawnFn: BashSpawnFn;

  constructor(spawnFn: BashSpawnFn = nodeSpawn as unknown as BashSpawnFn) {
    this.spawnFn = spawnFn;
  }

  spawn(opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]): SpawnedTerminalProcess {
    const command = opts.spec.command ?? opts.defaultShell;
    const args = opts.spec.command ? opts.spec.args ?? [] : [];
    const child = this.spawnFn(command, args, {
      cwd: opts.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.stdout?.on('data', (chunk: Buffer | string) => opts.emitOutput(chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer | string) => opts.emitOutput(chunk.toString()));
    child.once('exit', (code: number | null) => opts.emitExit(code ?? undefined));
    child.once('error', (err) => {
      opts.emitOutput(`\n[embedded-terminal error] ${err.message}\n`);
      opts.emitExit(undefined);
    });

    return {
      write(data: string) {
        child.stdin.write(data);
      },
      resize() {
        // Pipe-backed child processes are not TTYs; resize is a no-op.
      },
      close() {
        try {
          if (!child.killed) child.kill();
        } catch {
          /* already dead */
        }
      },
    };
  }
}

export function createBashTerminalBackend(
  options: BashTerminalBackendOptions = {},
): EmbeddedTerminalBackend {
  return new BashTerminalBackend(options.spawnFn);
}

export class EmbeddedTerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, SessionState>();
  private readonly targetIndex = new Map<string, string>();
  private readonly backend: EmbeddedTerminalBackend;
  private readonly defaultShell: string;

  constructor(options: EmbeddedTerminalManagerOptions = {}) {
    super();
    this.backend = resolveBackend(options);
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
      const process = this.backend.spawn({
        spec: opts.spec,
        cwd: opts.cwd,
        defaultShell: this.defaultShell,
        emitOutput: (data) => this.emitOutput(sessionId, opts.taskId, data),
        emitExit: (exitCode) => this.finalizeSession(state, exitCode),
      });
      state = {
        ...base,
        mode: 'spawn',
        backend: this.backend.name,
        process,
      };
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
      state.process.write(data);
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
      state.process.resize(cols, rows);
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

  closeAll(): void {
    for (const state of Array.from(this.sessions.values())) {
      this.finalizeSession(state, undefined);
    }
  }

  private finalizeSession(state: SessionState, exitCode: number | undefined): void {
    if (state.status === 'exited') return;
    state.status = 'exited';
    state.exitCode = exitCode;

    if (state.mode === 'spawn') {
      state.process.close();
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

function resolveBackend(options: EmbeddedTerminalManagerOptions): EmbeddedTerminalBackend {
  if (options.backend) return options.backend;
  return createBashTerminalBackend();
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

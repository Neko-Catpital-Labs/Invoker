/**
 * Embedded terminal manager (main process).
 *
 * Owns GUI terminal sessions and delegates spawned sessions to a backend.
 * Headless open-terminal is intentionally not routed through this manager; it
 * continues to use the external OS terminal launcher.
 */

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
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

export type EmbeddedTerminalBackendName = 'bash' | 'pty';

const MAX_OUTPUT_SNAPSHOT_CHARS = 64 * 1024;

export interface PtyForkOptionsLike {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string | undefined>;
}

export interface PtyLike {
  onData(listener: (data: string) => void): { dispose: () => void };
  onExit(listener: (event: { exitCode: number }) => void): { dispose: () => void };
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

/** Factory used by the optional PTY backend. Tests can supply a fake. */
export type PtySpawnFn = (
  command: string,
  args: readonly string[],
  options: PtyForkOptionsLike,
) => PtyLike;

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

export interface PtyTerminalBackendOptions {
  /** Override the node-pty spawn function for this PTY backend instance. */
  spawnFn?: PtySpawnFn;
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
  outputSnapshot: string;
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
  /** Single backend used for GUI spawned sessions. Defaults to the PTY backend. */
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
    outputSnapshot: state.outputSnapshot,
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

class PtyTerminalBackend implements EmbeddedTerminalBackend {
  readonly name = 'pty' as const;
  private readonly spawnFn: PtySpawnFn;

  constructor(spawnFn?: PtySpawnFn) {
    this.spawnFn = spawnFn ?? loadNodePtySpawn();
  }

  spawn(opts: Parameters<EmbeddedTerminalBackend['spawn']>[0]): SpawnedTerminalProcess {
    const command = opts.spec.command ?? opts.defaultShell;
    const args = opts.spec.command ? opts.spec.args ?? [] : [];
    const pty = this.spawnFn(command, args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: opts.cwd,
      env: { ...process.env, TERM: process.env.TERM ?? 'xterm-256color' },
    });
    const dataDisposable = pty.onData(opts.emitOutput);
    const exitDisposable = pty.onExit(({ exitCode }) => opts.emitExit(exitCode));

    return {
      write(data: string) {
        pty.write(data);
      },
      resize(cols: number, rows: number) {
        pty.resize(cols, rows);
      },
      close() {
        try {
          dataDisposable.dispose();
          exitDisposable.dispose();
        } catch {
          /* listener disposal is best-effort */
        }
        try {
          pty.kill();
        } catch {
          /* already dead */
        }
      },
    };
  }
}

export function createPtyTerminalBackend(
  options: PtyTerminalBackendOptions = {},
): EmbeddedTerminalBackend {
  return new PtyTerminalBackend(options.spawnFn);
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
      outputSnapshot: '',
    };

    if (opts.attach) {
      const state: AttachedSessionState = {
        ...base,
        mode: 'attached',
        attach: opts.attach,
        unsubscribeOutput: () => {},
      };
      this.sessions.set(sessionId, state);
      this.targetIndex.set(targetKey, sessionId);

      let unsubscribe: () => void;
      try {
        unsubscribe = opts.attach.executor.onOutput(opts.attach.handle, (data) => {
          this.emitOutput(state, data);
        });
      } catch (err) {
        this.sessions.delete(sessionId);
        if (this.targetIndex.get(targetKey) === sessionId) {
          this.targetIndex.delete(targetKey);
        }
        throw err;
      }
      state.unsubscribeOutput = unsubscribe;
      if (state.status === 'exited') {
        try {
          unsubscribe();
        } catch {
          /* unsubscribe is best-effort */
        }
      }
      return describeSession(state);
    }

    const pendingProcess: SpawnedTerminalProcess = {
      write() {
        throw new Error(`Session "${sessionId}" process is not ready.`);
      },
      resize() {
        // Resize before the backend returns a process handle is ignored.
      },
      close() {
        // There is no process handle to close yet.
      },
    };
    const state: SpawnSessionState = {
      ...base,
      mode: 'spawn',
      backend: this.backend.name,
      process: pendingProcess,
    };
    this.sessions.set(sessionId, state);
    this.targetIndex.set(targetKey, sessionId);

    const noPendingExit = Symbol('no-pending-exit');
    let pendingExitCode: number | undefined | typeof noPendingExit = noPendingExit;
    try {
      const process = this.backend.spawn({
        spec: opts.spec,
        cwd: opts.cwd,
        defaultShell: this.defaultShell,
        emitOutput: (data) => this.emitOutput(state, data),
        emitExit: (exitCode) => {
          if (state.process === pendingProcess) {
            pendingExitCode = exitCode;
            return;
          }
          this.finalizeSession(state, exitCode);
        },
      });
      state.process = process;
      if (state.status === 'exited') {
        try {
          process.close();
        } catch {
          /* process cleanup is best-effort */
        }
      }
    } catch (err) {
      this.sessions.delete(sessionId);
      if (this.targetIndex.get(targetKey) === sessionId) {
        this.targetIndex.delete(targetKey);
      }
      throw err;
    }

    if (pendingExitCode !== noPendingExit) {
      this.finalizeSession(state, pendingExitCode);
    }

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

  private emitOutput(state: SessionState, data: string): void {
    state.outputSnapshot = trimOutputSnapshot(state.outputSnapshot + data);
    const payload: TerminalOutputEvent = {
      sessionId: state.sessionId,
      taskId: state.taskId,
      data,
    };
    this.emit('output', payload);
  }
}

function trimOutputSnapshot(snapshot: string): string {
  if (snapshot.length <= MAX_OUTPUT_SNAPSHOT_CHARS) return snapshot;
  return snapshot.slice(snapshot.length - MAX_OUTPUT_SNAPSHOT_CHARS);
}

function resolveBackend(options: EmbeddedTerminalManagerOptions): EmbeddedTerminalBackend {
  if (options.backend) return options.backend;
  return createPtyTerminalBackend();
}

function loadNodePtySpawn(): PtySpawnFn {
  try {
    const nodeRequire = createRequire(__filename);
    const mod = nodeRequire('node-pty') as { spawn?: PtySpawnFn };
    if (typeof mod.spawn !== 'function') {
      throw new Error('node-pty does not export spawn()');
    }
    return mod.spawn;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Embedded terminal PTY backend requested, but node-pty is unavailable or not built: ${detail}`,
    );
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

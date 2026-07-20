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
import type { TerminalSessionRecord } from '@invoker/data-store';
import type { Executor, ExecutorHandle, TerminalSpec } from '@invoker/execution-engine';

export type EmbeddedTerminalBackendName = 'bash' | 'pty';
export type EmbeddedTerminalSessionKind = 'task' | 'planning';

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


export interface TerminalSessionPersistenceRecord extends TerminalSessionRecord {
  spec: TerminalSpec;
  kind: EmbeddedTerminalSessionKind;
  planningSessionId?: string;
}
export interface OpenSessionOptions {
  taskId: string;
  kind?: EmbeddedTerminalSessionKind;
  planningSessionId?: string;
  spec: TerminalSpec;
  cwd: string;
  /** Initial display-only content to seed the terminal snapshot before process output. */
  outputSnapshot?: string;
  /** When provided, the session attaches to the running executor rather than spawning a child. */
  attach?: AttachContext;
}
interface BaseSessionState {
  sessionId: string;
  taskId: string;
  kind: EmbeddedTerminalSessionKind;
  planningSessionId?: string;
  targetKey: string;
  spec: TerminalSpec;
  cwd: string;
  createdAt: string;
  updatedAt: string;
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


function describePersistenceRecord(state: SessionState): TerminalSessionPersistenceRecord {
  return {
    sessionId: state.sessionId,
    taskId: state.taskId,
    kind: state.kind,
    planningSessionId: state.planningSessionId,
    targetKey: state.targetKey,
    status: state.status,
    exitCode: state.exitCode,
    cwd: state.cwd,
    command: state.spec.command,
    args: state.spec.args,
    linuxTerminalTail: state.spec.linuxTerminalTail,
    mode: state.mode,
    attached: state.mode === 'attached',
    outputSnapshot: state.outputSnapshot,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    spec: state.spec,
  };
}
function describeSession(state: SessionState): TerminalSessionDescriptor {
  return {
    sessionId: state.sessionId,
    taskId: state.taskId,
    kind: state.kind,
    planningSessionId: state.planningSessionId,
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
  private readonly preserveForRestartSessionIds = new Set<string>();
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
    const existing = this.getRunningDescriptorForTarget(targetKey);
    if (existing) return existing;

    const sessionId = randomUUID();
    const createdAt = new Date().toISOString();
    const base = {
      sessionId,
      taskId: opts.taskId,
      kind: opts.kind ?? 'task',
      planningSessionId: opts.planningSessionId,
      targetKey,
      spec: opts.spec,
      cwd: opts.cwd,
      createdAt,
      updatedAt: createdAt,
      status: 'running' as const,
      outputSnapshot: opts.outputSnapshot ?? '',
    };

    if (opts.attach) {
      const state: AttachedSessionState = {
        ...base,
        mode: 'attached',
        attach: opts.attach,
        unsubscribeOutput: () => {},
      };
      this.registerLiveSession(state);

      let unsubscribe: () => void;
      try {
        unsubscribe = opts.attach.executor.onOutput(opts.attach.handle, (data) => {
          this.emitOutput(state, data);
        });
      } catch (err) {
        this.removeLiveSession(state);
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
      this.emitSessionUpdated(state);
      return describeSession(state);
    }

    return this.registerSpawnSession(base);
  }

  restoreSpawnSession(seed: {
    sessionId: string;
    taskId: string;
    kind?: EmbeddedTerminalSessionKind;
    planningSessionId?: string;
    targetKey: string;
    spec: TerminalSpec;
    cwd: string;
    createdAt: string;
    outputSnapshot: string;
  }): TerminalSessionDescriptor {
    const existingSession = this.sessions.get(seed.sessionId);
    if (existingSession) {
      if (
        existingSession.taskId !== seed.taskId
        || existingSession.targetKey !== seed.targetKey
      ) {
        throw new Error(`Terminal session "${seed.sessionId}" restored with mismatched identity.`);
      }
      return describeSession(existingSession);
    }
    const existingTarget = this.getRunningDescriptorForTarget(seed.targetKey);
    if (existingTarget && existingTarget.sessionId !== seed.sessionId) {
      throw new Error(`Terminal target "${seed.targetKey}" already has running session "${existingTarget.sessionId}".`);
    }

    return this.registerSpawnSession({
      sessionId: seed.sessionId,
      taskId: seed.taskId,
      kind: seed.kind ?? 'task',
      planningSessionId: seed.planningSessionId,
      targetKey: seed.targetKey,
      spec: seed.spec,
      cwd: seed.cwd,
      createdAt: seed.createdAt,
      updatedAt: new Date().toISOString(),
      status: 'running' as const,
      outputSnapshot: seed.outputSnapshot,
    });
  }

  list(): TerminalSessionDescriptor[] {
    return Array.from(this.sessions.values()).map(describeSession);
  }

  get(sessionId: string): TerminalSessionDescriptor | undefined {
    const state = this.sessions.get(sessionId);
    return state ? describeSession(state) : undefined;
  }

  getPersistenceRecord(sessionId: string): TerminalSessionPersistenceRecord | undefined {
    const state = this.sessions.get(sessionId);
    return state ? describePersistenceRecord(state) : undefined;
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

  closeAll(options?: { preserveForRestart?: boolean }): void {
    if (options?.preserveForRestart) {
      for (const state of Array.from(this.sessions.values())) {
        this.preserveForRestartSessionIds.add(state.sessionId);
        if (state.mode === 'spawn') {
          state.process.close();
        } else {
          try {
            state.unsubscribeOutput();
          } catch {
            /* unsubscribe is best-effort */
          }
        }
      }
      this.sessions.clear();
      this.targetIndex.clear();
      this.assertLiveSessionInvariants();
      return;
    }

    for (const state of Array.from(this.sessions.values())) {
      this.finalizeSession(state, undefined);
    }
  }

  private registerLiveSession(state: SessionState): void {
    const existingSession = this.sessions.get(state.sessionId);
    if (existingSession) {
      throw new Error(`Terminal session "${state.sessionId}" is already registered.`);
    }

    const existingTargetSessionId = this.targetIndex.get(state.targetKey);
    if (existingTargetSessionId && existingTargetSessionId !== state.sessionId) {
      const existingTargetSession = this.sessions.get(existingTargetSessionId);
      if (existingTargetSession?.status === 'running') {
        throw new Error(
          `Terminal target "${state.targetKey}" is already registered to session "${existingTargetSessionId}".`,
        );
      }
      this.targetIndex.delete(state.targetKey);
      if (existingTargetSession) {
        this.sessions.delete(existingTargetSessionId);
      }
    }

    this.sessions.set(state.sessionId, state);
    this.targetIndex.set(state.targetKey, state.sessionId);
    this.assertLiveSessionInvariants();
  }

  private removeLiveSession(state: SessionState): void {
    if (this.targetIndex.get(state.targetKey) === state.sessionId) {
      this.targetIndex.delete(state.targetKey);
    }
    this.sessions.delete(state.sessionId);
  }

  private assertLiveSessionInvariants(): void {
    for (const [targetKey, sessionId] of this.targetIndex.entries()) {
      const state = this.sessions.get(sessionId);
      if (!state) {
        throw new Error(`Terminal target index for "${targetKey}" points to missing session "${sessionId}".`);
      }
      if (state.targetKey !== targetKey) {
        throw new Error(`Terminal target index for "${targetKey}" points to mismatched session "${sessionId}".`);
      }
      if (state.status !== 'running') {
        throw new Error(`Terminal target index for "${targetKey}" points to non-running session "${sessionId}".`);
      }
    }

    for (const [sessionId, state] of this.sessions.entries()) {
      if (this.targetIndex.get(state.targetKey) !== sessionId) {
        throw new Error(`Terminal session "${sessionId}" is missing target index entry for "${state.targetKey}".`);
      }
    }
  }

  private getRunningDescriptorForTarget(targetKey: string): TerminalSessionDescriptor | undefined {
    const existingId = this.targetIndex.get(targetKey);
    if (!existingId) return undefined;
    const existing = this.sessions.get(existingId);
    if (existing && existing.status === 'running') return describeSession(existing);
    this.targetIndex.delete(targetKey);
    if (existing) this.sessions.delete(existingId);
    return undefined;
  }

  private registerSpawnSession(
    base: Omit<SpawnSessionState, 'backend' | 'process' | 'mode'>,
  ): TerminalSessionDescriptor {
    const pendingProcess: SpawnedTerminalProcess = {
      write() {
        throw new Error(`Session "${base.sessionId}" process is not ready.`);
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
    this.registerLiveSession(state);

    const noPendingExit = Symbol('no-pending-exit');
    let pendingExitCode: number | undefined | typeof noPendingExit = noPendingExit;
    try {
      const process = this.backend.spawn({
        spec: state.spec,
        cwd: state.cwd,
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
      this.removeLiveSession(state);
      throw err;
    }

    if (pendingExitCode !== noPendingExit) {
      this.finalizeSession(state, pendingExitCode);
    } else if (state.status === 'running') {
      this.emitSessionUpdated(state);
    }

    return describeSession(state);
  }

  private finalizeSession(state: SessionState, exitCode: number | undefined): void {
    if (state.status === 'exited' || this.preserveForRestartSessionIds.has(state.sessionId)) return;
    state.status = 'exited';
    state.exitCode = exitCode;
    state.updatedAt = new Date().toISOString();
    this.emitSessionUpdated(state);

    if (state.mode === 'spawn') {
      state.process.close();
    } else {
      try {
        state.unsubscribeOutput();
      } catch {
        /* unsubscribe is best-effort */
      }
    }

    this.removeLiveSession(state);

    this.assertLiveSessionInvariants();

    const payload: TerminalExitEvent = {
      sessionId: state.sessionId,
      taskId: state.taskId,
      kind: state.kind,
      planningSessionId: state.planningSessionId,
      exitCode,
    };
    this.emit('exit', payload);
  }

  private emitOutput(state: SessionState, data: string): void {
    state.outputSnapshot = trimOutputSnapshot(state.outputSnapshot + data);
    state.updatedAt = new Date().toISOString();
    const payload: TerminalOutputEvent = {
      sessionId: state.sessionId,
      taskId: state.taskId,
      kind: state.kind,
      planningSessionId: state.planningSessionId,
      data,
    };
    this.emit('output', payload);
    this.emitSessionUpdated(state);
  }

  private emitSessionUpdated(state: SessionState): void {
    this.emit('session-updated', describePersistenceRecord(state));
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
  const taskTarget = {
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
  };

  if ((opts.kind ?? 'task') !== 'planning') {
    return JSON.stringify(taskTarget);
  }

  return JSON.stringify({
    kind: 'planning',
    planningSessionId: opts.planningSessionId ?? opts.taskId,
    ...taskTarget,
  });
}

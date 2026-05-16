/**
 * Embedded terminal session manager (Electron main process).
 *
 * Replaces the GUI's external OS terminal launcher for task double-click. The
 * GUI invoker:open-terminal IPC handler delegates here; the manager:
 *
 *   - Resolves a TerminalSpec from persisted task metadata via the shared
 *     `resolveTaskTerminalSpec` helper (so the managed-workspace invariants and
 *     codex session repair logic are not duplicated).
 *   - For a non-running task: spawns a PTY using a pluggable backend
 *     (`node-pty` in production, child_process shim in tests).
 *   - For a running task that has an active executor handle: attaches to the
 *     executor via `executor.onOutput` / `executor.sendInput` instead of
 *     trying to spawn a competing PTY against the same workspace.
 *
 * Sessions are keyed by `taskId` so reopening the same task reuses the
 * session — the manager tracks the descriptor and broadcasts output / exit
 * via the injected `emit` callbacks.
 */

import { randomUUID } from 'node:crypto';
import type { Logger, TerminalSessionDescriptor, TerminalSessionStatus } from '@invoker/contracts';
import type {
  Executor,
  ExecutorHandle,
  TerminalSpec,
  Unsubscribe,
} from '@invoker/execution-engine';
import {
  resolveTaskTerminalSpec,
  type OpenExternalTerminalForTaskOptions,
} from './open-terminal-for-task.js';
import {
  defaultTerminalBackend,
  type TerminalBackend,
  type TerminalProcess,
} from './terminal-pty-backend.js';

/** Lookup for the active executor handle for a running task. */
export type TaskHandleLookup = (
  taskId: string,
) => { handle: ExecutorHandle; executor: Executor } | undefined;

export interface EmbeddedTerminalSessionManagerOptions {
  /**
   * Resolves the running executor handle for a task. Pass the same map that
   * `setupGuiMode` populates from `onSpawned` / `onComplete`. Optional — the
   * manager just spawns a PTY when no handle is available.
   */
  getTaskHandle?: TaskHandleLookup;
  /** Backend factory — defaults to node-pty with child_process fallback. */
  backend?: TerminalBackend;
  /** Forwarded to spawned PTYs. */
  env?: Record<string, string>;
  /** Logger (uses Logger interface from contracts). */
  logger?: Logger;
  /** Emit a chunk of data for an active session to the renderer. */
  emitOutput?: (event: { sessionId: string; taskId: string; data: string }) => void;
  /** Emit an exit event when a session terminates. */
  emitExit?: (event: { sessionId: string; taskId: string; exitCode?: number; reason?: string }) => void;
}

interface PtySession {
  kind: 'pty';
  descriptor: TerminalSessionDescriptor;
  process: TerminalProcess;
  unsubscribeData: Unsubscribe;
  unsubscribeExit: Unsubscribe;
}

interface ExecutorAttachedSession {
  kind: 'executor';
  descriptor: TerminalSessionDescriptor;
  unsubscribeOutput: Unsubscribe;
  executor: Executor;
  handle: ExecutorHandle;
}

type Session = PtySession | ExecutorAttachedSession;

export class EmbeddedTerminalSessionManager {
  private readonly sessionsById = new Map<string, Session>();
  private readonly sessionIdByTask = new Map<string, string>();
  private readonly options: EmbeddedTerminalSessionManagerOptions;

  constructor(options: EmbeddedTerminalSessionManagerOptions = {}) {
    this.options = options;
  }

  /**
   * Open or reuse a session for the given task. The returned descriptor is
   * the same shape the IPC channel and renderer consume.
   */
  async open(
    opts: OpenExternalTerminalForTaskOptions,
  ): Promise<{ opened: true; session: TerminalSessionDescriptor } | { opened: false; reason: string }> {
    const existingId = this.sessionIdByTask.get(opts.taskId);
    if (existingId) {
      const existing = this.sessionsById.get(existingId);
      if (existing && existing.descriptor.status !== 'exited' && existing.descriptor.status !== 'error') {
        const reused: TerminalSessionDescriptor = { ...existing.descriptor, reused: true };
        return { opened: true, session: reused };
      }
      // Stale entry — drop it before opening a fresh session.
      this.disposeSession(existingId, 'stale-reset');
    }

    const resolved = resolveTaskTerminalSpec({ ...opts, treatRunningAsError: false });
    if (!resolved.ok) {
      return { opened: false, reason: resolved.reason };
    }

    const { spec, taskStatus } = resolved;
    const sessionId = randomUUID();

    const handleEntry = this.options.getTaskHandle?.(opts.taskId);
    const isLiveTask = taskStatus === 'running' || taskStatus === 'fixing_with_ai';

    if (isLiveTask && handleEntry) {
      return this.attachToExecutor({
        sessionId,
        taskId: opts.taskId,
        spec,
        executor: handleEntry.executor,
        handle: handleEntry.handle,
      });
    }

    return this.spawnPtySession({
      sessionId,
      taskId: opts.taskId,
      spec,
      defaultCwd: opts.repoRoot,
    });
  }

  /**
   * Mark a session "selected" without changing its state — the renderer can
   * use this to focus a previously-opened terminal tab.
   */
  select(sessionId: string): { selected: true; session: TerminalSessionDescriptor } | { selected: false; reason: string } {
    const session = this.sessionsById.get(sessionId);
    if (!session) return { selected: false, reason: `No session "${sessionId}"` };
    return { selected: true, session: { ...session.descriptor } };
  }

  list(): TerminalSessionDescriptor[] {
    return Array.from(this.sessionsById.values()).map((s) => ({ ...s.descriptor }));
  }

  write(sessionId: string, data: string): { ok: boolean; reason?: string } {
    const session = this.sessionsById.get(sessionId);
    if (!session) return { ok: false, reason: `No session "${sessionId}"` };
    if (session.descriptor.status === 'exited' || session.descriptor.status === 'error') {
      return { ok: false, reason: `Session "${sessionId}" is ${session.descriptor.status}` };
    }
    try {
      if (session.kind === 'pty') {
        session.process.write(data);
      } else {
        session.executor.sendInput(session.handle, data);
      }
      return { ok: true };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { ok: false, reason };
    }
  }

  resize(sessionId: string, cols: number, rows: number): { ok: boolean; reason?: string } {
    const session = this.sessionsById.get(sessionId);
    if (!session) return { ok: false, reason: `No session "${sessionId}"` };
    if (session.kind === 'pty') {
      try {
        session.process.resize(cols, rows);
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        return { ok: false, reason };
      }
    }
    // executor-attached sessions don't expose a TTY resize hook — ack quietly
    // so the renderer can still send resize messages uniformly.
    return { ok: true };
  }

  close(sessionId: string): { ok: boolean; reason?: string } {
    const session = this.sessionsById.get(sessionId);
    if (!session) return { ok: false, reason: `No session "${sessionId}"` };
    if (session.kind === 'pty') {
      try {
        session.process.kill();
      } catch {
        /* already exited */
      }
    }
    this.disposeSession(sessionId, 'closed-by-caller');
    return { ok: true };
  }

  /**
   * Tear down every session — call on app shutdown.
   */
  destroyAll(): void {
    for (const id of Array.from(this.sessionsById.keys())) {
      this.close(id);
    }
  }

  // ── Internals ────────────────────────────────────────────────

  private spawnPtySession(params: {
    sessionId: string;
    taskId: string;
    spec: TerminalSpec;
    defaultCwd: string;
  }): { opened: true; session: TerminalSessionDescriptor } | { opened: false; reason: string } {
    const { sessionId, taskId, spec, defaultCwd } = params;
    const command = spec.command ?? defaultShellCommand();
    const args = spec.command ? spec.args ?? [] : defaultShellArgs();
    const cwd = spec.cwd ?? defaultCwd;
    const backend = this.options.backend ?? defaultTerminalBackend;

    let proc: TerminalProcess;
    try {
      proc = backend({
        command,
        args,
        cwd,
        env: this.options.env,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.options.logger?.error(
        `Failed to spawn PTY for task ${taskId}: ${reason}`,
        { module: 'embedded-terminal' },
      );
      return { opened: false, reason };
    }

    const descriptor: TerminalSessionDescriptor = {
      sessionId,
      taskId,
      mode: 'pty',
      status: 'running',
      reused: false,
      cwd,
      command,
      args,
    };

    const unsubscribeData = proc.onData((chunk) => {
      this.options.emitOutput?.({ sessionId, taskId, data: chunk });
    });
    const unsubscribeExit = proc.onExit((exitCode) => {
      const stored = this.sessionsById.get(sessionId);
      if (stored) {
        stored.descriptor.status = 'exited';
        stored.descriptor.exitCode = exitCode ?? undefined;
      }
      this.options.emitExit?.({ sessionId, taskId, exitCode: exitCode ?? undefined });
    });

    this.sessionsById.set(sessionId, {
      kind: 'pty',
      descriptor,
      process: proc,
      unsubscribeData,
      unsubscribeExit,
    });
    this.sessionIdByTask.set(taskId, sessionId);

    return { opened: true, session: { ...descriptor } };
  }

  private attachToExecutor(params: {
    sessionId: string;
    taskId: string;
    spec: TerminalSpec;
    executor: Executor;
    handle: ExecutorHandle;
  }): { opened: true; session: TerminalSessionDescriptor } | { opened: false; reason: string } {
    const { sessionId, taskId, spec, executor, handle } = params;
    const descriptor: TerminalSessionDescriptor = {
      sessionId,
      taskId,
      mode: 'executor-attached',
      status: 'running',
      reused: false,
      cwd: spec.cwd,
      command: spec.command,
      args: spec.args,
    };

    let unsubscribeOutput: Unsubscribe = () => {};
    try {
      unsubscribeOutput = executor.onOutput(handle, (chunk) => {
        this.options.emitOutput?.({ sessionId, taskId, data: chunk });
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.options.logger?.error(
        `Failed to attach to executor for task ${taskId}: ${reason}`,
        { module: 'embedded-terminal' },
      );
      return { opened: false, reason };
    }

    this.sessionsById.set(sessionId, {
      kind: 'executor',
      descriptor,
      executor,
      handle,
      unsubscribeOutput,
    });
    this.sessionIdByTask.set(taskId, sessionId);

    return { opened: true, session: { ...descriptor } };
  }

  private disposeSession(sessionId: string, reason: string): void {
    const session = this.sessionsById.get(sessionId);
    if (!session) return;
    if (session.kind === 'pty') {
      try { session.unsubscribeData(); } catch { /* noop */ }
      try { session.unsubscribeExit(); } catch { /* noop */ }
    } else {
      try { session.unsubscribeOutput(); } catch { /* noop */ }
    }
    this.sessionsById.delete(sessionId);
    if (this.sessionIdByTask.get(session.descriptor.taskId) === sessionId) {
      this.sessionIdByTask.delete(session.descriptor.taskId);
    }
    const prevStatus: TerminalSessionStatus = session.descriptor.status;
    if (prevStatus !== 'exited' && prevStatus !== 'error') {
      this.options.emitExit?.({
        sessionId,
        taskId: session.descriptor.taskId,
        reason,
      });
    }
  }
}

function defaultShellCommand(): string {
  if (process.platform === 'win32') return process.env.COMSPEC ?? 'cmd.exe';
  return process.env.SHELL ?? '/bin/bash';
}

function defaultShellArgs(): string[] {
  if (process.platform === 'win32') return [];
  // Login + interactive so PATH and aliases match user expectations.
  return ['-l', '-i'];
}

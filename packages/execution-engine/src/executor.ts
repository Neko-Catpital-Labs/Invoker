import type { ChildProcess } from 'node:child_process';
import { terminateChildProcessGroup } from './process-utils.js';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';

export class StartupCancelledError extends Error {
  constructor(readonly reason: 'timeout' | 'stale', message: string) {
    super(message);
    this.name = 'StartupCancelledError';
  }
}

export class ExecutorStartup {
  private readonly controller = new AbortController();
  readonly signal: AbortSignal = this.controller.signal;

  constructor(
    readonly deadlineMs: number,
    private readonly timeoutError: StartupCancelledError,
    private readonly isCurrent: () => boolean = () => true,
  ) {}

  cancel(error: unknown = this.timeoutError): void {
    if (!this.signal.aborted) this.controller.abort(error);
  }

  check(): void {
    if (!this.signal.aborted && Date.now() >= this.deadlineMs) this.cancel();
    if (!this.signal.aborted && !this.isCurrent()) {
      this.cancel(new StartupCancelledError('stale', 'Executor startup attempt is no longer current'));
    }
    this.signal.throwIfAborted();
  }

  async waitForSharedOperation<T>(operation: Promise<T>): Promise<T> {
    let onAbort!: () => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(this.signal.reason);
      this.signal.addEventListener('abort', onAbort, { once: true });
      if (this.signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([operation, cancelled]);
      this.check();
      return result;
    } finally {
      this.signal.removeEventListener('abort', onAbort);
    }
  }
}

export function cancelOwnedStartupChild(child: ChildProcess, startup?: ExecutorStartup): void {
  if (!startup) return;
  let closed = false;
  const abort = () => { void terminateChildProcessGroup(child, () => closed); };
  child.once('close', () => {
    closed = true;
    startup.signal.removeEventListener('abort', abort);
  });
  startup.signal.addEventListener('abort', abort, { once: true });
  if (startup.signal.aborted) abort();
}

export type Unsubscribe = () => void;

export interface ExecutorHandle {
  executionId: string;
  taskId: string;
  /** Optional display-only text to show before terminal process output. */
  displayOnlyBridgeText?: string;
  agentSessionId?: string;
  containerId?: string;
  workspacePath?: string;
  branch?: string;
  /**
   * Set when this executor claimed a DB-backed resource lease during
   * start() (e.g. a worktree slot) that dispatch should renew on heartbeat
   * and release on completion via the generic `activeExecution.leaseResourceKey`/
   * `leaseHolderId` path already used for SSH pool-member leases.
   */
  leaseResourceKey?: string;
  leaseHolderId?: string;
}

export interface TerminalSpec {
  /** Working directory for the terminal. Used when no command is specified. */
  cwd?: string;
  /** Command to execute inside the terminal (e.g., 'docker', 'ssh'). */
  command?: string;
  /** Arguments for the command. */
  args?: string[];
  /** Tail command for Linux terminal launch (e.g. 'exec_bash' or 'pause'). */
  linuxTerminalTail?: 'exec_bash' | 'pause';
  /** Initial PTY column count. Defaults to 80 when omitted. */
  cols?: number;
  /** Initial PTY row count. Defaults to 24 when omitted. */
  rows?: number;
  /** Optional bounded text rendered before terminal output; never passed to the process argv or stdin. */
  displayOnlyBridgeText?: string;
}

export interface PersistedTaskMeta {
  taskId: string;
  runnerKind: string;
  /** Optional display-only text to show before terminal process output. */
  displayOnlyBridgeText?: string;
  agentSessionId?: string;
  /** Configured execution agent name (e.g. 'claude', 'codex'). Used for session resume. */
  executionAgent?: string;
  containerId?: string;
  workspacePath?: string;
  branch?: string;
}

export interface Executor {
  readonly type: string;
  start(request: WorkRequest, startup?: ExecutorStartup): Promise<ExecutorHandle>;
  kill(handle: ExecutorHandle): Promise<void>;
  sendInput(handle: ExecutorHandle, input: string): void;
  onOutput(handle: ExecutorHandle, cb: (data: string) => void): Unsubscribe;
  onComplete(handle: ExecutorHandle, cb: (response: WorkResponse) => void): Unsubscribe;
  onHeartbeat(handle: ExecutorHandle, cb: (taskId: string) => void): Unsubscribe;
  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null;
  /**
   * Reconstruct a TerminalSpec from persisted DB metadata (no in-memory handle required).
   * Throws if the workspace path no longer exists on disk.
   */
  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec;
  destroyAll(): Promise<void>;
}

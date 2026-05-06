/**
 * HeadlessTransport — Single entry-point for headless command execution.
 *
 * Centralises the IPC-vs-standalone decision so callers don't need to know
 * whether an owner process is reachable, whether IPC delegation should be
 * attempted, or how to batch commands over the message bus.
 *
 * Two public methods:
 *   exec()      — execute a single headless command
 *   batchExec() — execute multiple commands with optional parallelism
 *
 * The transport resolves the owner mode once and reuses it for the lifetime
 * of the instance.
 */

import type { MessageBus } from '@invoker/transport';

import { isHeadlessMutatingCommand } from './headless-command-classification.js';
import {
  tryDelegateExec,
  tryDelegateRun,
  tryDelegateResume,
  tryPingHeadlessOwner,
} from './headless-delegation.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface HeadlessExecOptions {
  /** If true, delegated submission exits without tracking workflow progress. */
  noTrack?: boolean;
  /** If true, wait for human approval before starting execution. */
  waitForApproval?: boolean;
  /** Per-request timeout in ms (default: 30 000). */
  timeoutMs?: number;
}

export interface HeadlessExecResult {
  /** The args that were executed. */
  args: string[];
  /** Whether the execution succeeded. */
  ok: boolean;
  /** Response payload from the owner (when delegated). */
  response?: unknown;
  /** Error message (only when ok === false). */
  error?: string;
}

export interface HeadlessBatchOptions extends HeadlessExecOptions {
  /** Number of concurrent workers for batch execution (default: 1). */
  parallel?: number;
}

export type OwnerMode = 'standalone' | 'gui' | 'none';

export interface HeadlessTransportDeps {
  messageBus: MessageBus;
  /**
   * Optional callback to refresh the message bus connection.
   * Useful when the underlying IPC socket reconnects.
   */
  refreshMessageBus?: () => Promise<MessageBus>;
  /**
   * Callback to ensure a standalone owner is running.
   * Called when a mutating command arrives with no reachable owner.
   */
  ensureStandaloneOwner?: (bus?: MessageBus) => Promise<void>;
  /**
   * Callback to execute a command locally (e.g. via electron).
   * Called for read-only commands in standalone mode, or when IPC
   * delegation is not appropriate.
   */
  execLocal?: (args: string[]) => Promise<number>;
}

// ---------------------------------------------------------------------------
// Default timeout
// ---------------------------------------------------------------------------

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// HeadlessTransport
// ---------------------------------------------------------------------------

export class HeadlessTransport {
  private deps: HeadlessTransportDeps;
  private messageBus: MessageBus;

  constructor(deps: HeadlessTransportDeps) {
    this.deps = deps;
    this.messageBus = deps.messageBus;
  }

  // -----------------------------------------------------------------------
  // Public API
  // -----------------------------------------------------------------------

  /**
   * Execute a single headless command.
   *
   * The transport decides whether to delegate via IPC or execute locally:
   *   - Mutating commands are always delegated to a standalone owner.
   *   - Read-only commands are delegated if an owner is present, otherwise
   *     executed locally via `deps.execLocal`.
   */
  async exec(
    args: string[],
    options: HeadlessExecOptions = {},
  ): Promise<HeadlessExecResult> {
    const timeoutMs = options.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
    try {
      const delegated = await this.tryDelegate(args, {
        ...options,
        timeoutMs,
      });
      if (delegated) {
        return { args, ok: true, response: delegated.response };
      }
      // Delegation was not possible/applicable — run locally.
      if (this.deps.execLocal) {
        const exitCode = await this.deps.execLocal(args);
        return { args, ok: exitCode === 0, response: { exitCode } };
      }
      return {
        args,
        ok: false,
        error: 'No owner available and no local executor configured',
      };
    } catch (err) {
      return {
        args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Execute multiple headless commands with optional parallelism.
   *
   * Each command is independently dispatched via `exec()`, so failures in
   * one command do not abort the batch.
   *
   * Returns results in the same order as the input items.
   */
  async batchExec(
    items: Array<{ args: string[] }>,
    options: HeadlessBatchOptions = {},
  ): Promise<HeadlessExecResult[]> {
    const parallel = Math.max(1, options.parallel ?? 1);
    const results: HeadlessExecResult[] = new Array(items.length);
    let nextIndex = 0;

    const worker = async (): Promise<void> => {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        results[index] = await this.exec(items[index].args, options);
      }
    };

    const workerCount = Math.min(parallel, items.length);
    await Promise.all(
      Array.from({ length: workerCount }, () => worker()),
    );
    return results;
  }

  /**
   * Probe the current owner mode without executing any command.
   *
   * Returns 'standalone', 'gui', or 'none'.
   */
  async resolveOwnerMode(): Promise<OwnerMode> {
    const owner = await tryPingHeadlessOwner(this.messageBus, 2_000);
    if (!owner) return 'none';
    if (owner.mode === 'standalone') return 'standalone';
    if (owner.mode === 'gui') return 'gui';
    return 'none';
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  /**
   * Attempt IPC delegation. Returns `{ response }` on success, or `null`
   * if delegation was not possible (no owner, timeout, etc.).
   */
  private async tryDelegate(
    args: string[],
    options: HeadlessExecOptions,
  ): Promise<{ response: unknown } | null> {
    const { noTrack, waitForApproval, timeoutMs } = options;
    const command = args[0] ?? '';

    // Always try to delegate mutating commands via IPC.
    if (isHeadlessMutatingCommand(args)) {
      return this.delegateMutating(args, command, {
        noTrack,
        waitForApproval,
        timeoutMs,
      });
    }

    // Read-only: try delegation, fall back to local.
    return null;
  }

  private async delegateMutating(
    args: string[],
    command: string,
    options: HeadlessExecOptions,
  ): Promise<{ response: unknown } | null> {
    const { noTrack, waitForApproval, timeoutMs } = options;
    let bus = this.messageBus;

    // Check for an existing standalone owner.
    const owner = await tryPingHeadlessOwner(bus, 2_000);
    if (owner?.mode === 'standalone') {
      const ok = await this.dispatchToOwner(
        args,
        command,
        bus,
        { noTrack, waitForApproval, timeoutMs },
      );
      if (ok) return { response: { delegated: true } };
    }

    // If a GUI owner responded (not standalone), refresh and look for a
    // standalone owner (the GUI cannot handle mutations).
    if (owner && owner.mode !== 'standalone' && this.deps.refreshMessageBus) {
      bus = await this.deps.refreshMessageBus();
      this.messageBus = bus;
      const refreshed = await tryPingHeadlessOwner(bus, 1_000);
      if (refreshed?.mode === 'standalone') {
        const ok = await this.dispatchToOwner(
          args,
          command,
          bus,
          { noTrack, waitForApproval, timeoutMs },
        );
        if (ok) return { response: { delegated: true } };
      }
    }

    // No standalone owner reachable — bootstrap one if possible.
    if (this.deps.ensureStandaloneOwner) {
      if (this.deps.refreshMessageBus) {
        bus = await this.deps.refreshMessageBus();
        this.messageBus = bus;
      }
      await this.deps.ensureStandaloneOwner(bus);
      if (this.deps.refreshMessageBus) {
        bus = await this.deps.refreshMessageBus();
        this.messageBus = bus;
      }
      const ok = await this.dispatchToOwner(
        args,
        command,
        bus,
        { noTrack, waitForApproval, timeoutMs },
      );
      if (ok) return { response: { delegated: true } };
    }

    return null;
  }

  private async dispatchToOwner(
    args: string[],
    command: string,
    bus: MessageBus,
    options: HeadlessExecOptions,
  ): Promise<boolean> {
    const { noTrack, waitForApproval, timeoutMs } = options;

    if (command === 'run') {
      const planPath = args[1];
      if (!planPath) return false;
      return tryDelegateRun(planPath, bus, waitForApproval, noTrack, timeoutMs);
    }

    if (command === 'resume') {
      const workflowId = args[1];
      if (!workflowId) return false;
      return tryDelegateResume(
        workflowId,
        bus,
        waitForApproval,
        noTrack,
        timeoutMs,
      );
    }

    return tryDelegateExec(args, bus, waitForApproval, noTrack, timeoutMs);
  }
}

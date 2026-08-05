/**
 * InvokerClient — drives a running Invoker over its IPC bus, and (re)launches it
 * when it's down.
 *
 * Invoker exposes an owner socket (`~/.invoker/ipc-transport.sock`). A client
 * bus (`allowServe:false`) connects to it and uses the `headless.*` request
 * channels: `owner-ping` (health), `query` (structured reads), `exec`
 * (mutations), `run` (submit a plan). The client also subscribes to broadcast
 * channels (`task.delta`, `surface.event`) for live forwarding.
 *
 * The IpcBus does NOT auto-reconnect: a client created while the owner is down,
 * or whose owner dies, stays peerless forever. So this client tears down and
 * re-probes a fresh bus whenever a request reports the transport is down, and
 * re-applies subscriptions + fires `onReconnect` the moment a fresh probe
 * connects to a live owner.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
  type MessageHandler,
  type Unsubscribe,
} from '@invoker/transport';
import { resolveInvokerHomeRoot, resolveInvokerIpcSocketPath } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowStatus } from '@invoker/surfaces';

/** A MessageBus that exposes connection readiness — i.e. an IpcBus client. */
export interface ConnectableBus extends MessageBus {
  ready(): Promise<void>;
}

/** Why a (re)launch did not produce a healthy owner. */
export type LaunchFailureCause = 'throttled' | 'unhealthy' | 'split-brain' | 'lock-unknown';

export interface LaunchResult {
  healthy: boolean;
  cause?: LaunchFailureCause;
  /** PID holding the DB writer lock while unreachable over IPC (split-brain only). */
  holderPid?: number;
  lockReadError?: string;
}

/** Thrown when an operation cannot reach the Invoker owner (transport-level down). */
export class InvokerDownError extends Error {
  constructor(
    message: string,
    readonly failureCause?: LaunchFailureCause,
    readonly holderPid?: number,
    readonly lockReadError?: string,
  ) {
    super(message);
    this.name = 'InvokerDownError';
  }
}

/** Operator-facing description of a down state, specific to the launch failure cause. */
export function describeInvokerDown(err: InvokerDownError): string {
  switch (err.failureCause) {
    case 'throttled':
      return 'Invoker is down. A relaunch was attempted less than a minute ago and the watchdog is still '
        + 'retrying, so I did not start another one. Try again shortly, or reply `@Invoker restart` to force a relaunch now.';
    case 'split-brain':
      return `Invoker cannot be relaunched: its database is locked by PID ${err.holderPid ?? '<unknown>'}, `
        + 'which is alive but not answering IPC (often a stray Invoker GUI). Reply `@Invoker restart` to force '
        + `recovery (this stops PID ${err.holderPid ?? '<unknown>'}), or stop that process manually.`;
    case 'lock-unknown':
      return 'Invoker cannot be relaunched: I could not confirm whether another process is holding the '
        + `database lock (${err.lockReadError ?? 'unreadable lock file'}). Reply \`@Invoker restart\` to force `
        + 'recovery, or check `~/.invoker/invoker.db.lock/pid` manually.';
    default:
      return 'Invoker is down and I could not bring it back. Reply `@Invoker restart` to retry.';
  }
}

/** Minimal workflow identity used for target resolution. */
export interface WorkflowSummary {
  id: string;
  name?: string;
}

/** A workflow's persisted record plus its tasks, as returned by `headless.query` `{kind:'workflow'}`. */
export interface WorkflowBundle {
  workflow: { name?: string } | undefined;
  tasks: TaskState[];
}

export interface InvokerClient {
  /** True when the owner answers `owner-ping` over IPC. Establishes/repairs the live bus as a side effect. */
  ping(): Promise<boolean>;
  /** True when the owner answers IPC ping OR the HTTP `/api/health` endpoint. */
  isHealthy(): Promise<boolean>;
  listWorkflows(): Promise<WorkflowSummary[]>;
  getWorkflowBundle(workflowId: string): Promise<WorkflowBundle>;
  getWorkflowStatus(workflowId?: string): Promise<WorkflowStatus>;
  getTaskOutput(taskId: string): Promise<string>;
  /** Run a delegated headless mutation (`approve`, `recreate`, `cancel-workflow`, …). Fire-and-forget. */
  exec(args: string[]): Promise<void>;
  /** Submit a plan file; resolves to the created workflow id(s). `workflowIds` covers stacked plans in submission order. */
  run(planPath: string): Promise<{ workflowId: string; workflowIds: string[] }>;
  /** (Re)launch Invoker. `healthy: false` results carry the failure cause (throttle, timeout, split-brain). */
  launch(opts?: { force?: boolean }): Promise<LaunchResult>;
  /** Runs `fn`; on `InvokerDownError`, launches Invoker and retries once. Rethrows if still down. */
  withRecovery<T>(fn: () => Promise<T>): Promise<T>;
  /** Subscribe to a broadcast channel; survives reconnects (re-applied on a fresh bus). */
  subscribe(channel: string, handler: (message: unknown) => void): () => void;
  /** Register a callback fired whenever a fresh bus connects to a live owner. */
  onReconnect(handler: () => void): () => void;
  disconnect(): void;
}

export interface InvokerClientOptions {
  /** Starts a fresh detached Invoker owner process. Owns kill-and-respawn for force restarts. */
  spawnInvoker: () => void;
  log: (level: string, message: string) => void;
  socketPath?: string;
  /** HTTP health endpoint; defaults to `http://127.0.0.1:${INVOKER_API_PORT ?? 4100}/api/health`. */
  healthUrl?: string;
  /** Minimum ms between (non-forced) launches — guards against restart storms. Default 60_000. */
  minLaunchIntervalMs?: number;
  /** Max ms to wait for IPC health after a launch. Default 90_000. */
  launchHealthTimeoutMs?: number;
  /** Interval between health polls while waiting for launch. Default 2_000. */
  healthPollIntervalMs?: number;
  /** Per-ping IPC timeout. Default 1_000. */
  pingTimeoutMs?: number;
  // Injection points for tests:
  busFactory?: (socketPath: string) => ConnectableBus;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  httpHealthCheck?: () => Promise<boolean>;
  readLockHolderPid?: () => LockHolderReadResult;
  isPidAlive?: (pid: number) => boolean;
  terminatePid?: (pid: number) => void;
}

interface SubscriptionEntry {
  channel: string;
  handler: MessageHandler;
  unsub?: Unsubscribe;
}

const QUERY_TIMEOUT_MS = 5_000;
const OUTPUT_QUERY_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 60_000;
const LOCK_READ_UNKNOWN_ALERT_STREAK = 2;

function defaultSleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const timer = setTimeout(resolve, ms);
  timer.unref?.();
  return promise;
}

/** Race a promise against a timeout that rejects with `onTimeout()`. */
async function withTimeout<T>(p: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(onTimeout()), ms);
  timer.unref?.();
  p.then(resolve, reject);
  try {
    return await promise;
  } finally {
    clearTimeout(timer);
  }
}

/** True for transport-level "owner is unreachable" errors (not owner-side handler failures). */
function isTransportDown(err: unknown): boolean {
  return err instanceof TransportError && (
    err.code === TransportErrorCode.NO_HANDLER
    || err.code === TransportErrorCode.DISCONNECTED
    || err.code === TransportErrorCode.REQUEST_TIMEOUT
  );
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export type LockHolderReadResult =
  | { kind: 'absent' }
  | { kind: 'found'; pid: number }
  | { kind: 'error'; detail: string };

function defaultReadLockHolderPid(): LockHolderReadResult {
  let raw: string;
  try {
    raw = readFileSync(join(resolveInvokerHomeRoot(), 'invoker.db.lock', 'pid'), 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'error', detail: errMessage(err) };
  }
  const pid = Number.parseInt(raw, 10);
  if (!Number.isFinite(pid)) return { kind: 'error', detail: `unparseable lock pid: ${JSON.stringify(raw)}` };
  return { kind: 'found', pid };
}

function defaultIsPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export class IpcInvokerClient implements InvokerClient {
  private readonly socketPath: string;
  private readonly healthUrl: string;
  private readonly spawnInvoker: () => void;
  private readonly log: (level: string, message: string) => void;
  private readonly minLaunchIntervalMs: number;
  private readonly launchHealthTimeoutMs: number;
  private readonly healthPollIntervalMs: number;
  private readonly pingTimeoutMs: number;
  private readonly busFactory: (socketPath: string) => ConnectableBus;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly httpHealthCheck: () => Promise<boolean>;
  private readonly readLockHolderPid: () => LockHolderReadResult;
  private readonly isPidAlive: (pid: number) => boolean;
  private readonly terminatePid: (pid: number) => void;

  private bus: ConnectableBus | null = null;
  private healthy = false;
  private lastLaunchAt = 0;
  private launchInFlight: Promise<LaunchResult> | null = null;
  private lockReadUnknownStreak = 0;
  private readonly subs = new Set<SubscriptionEntry>();
  private readonly reconnectHandlers = new Set<() => void>();

  constructor(options: InvokerClientOptions) {
    this.socketPath = options.socketPath ?? resolveInvokerIpcSocketPath();
    this.healthUrl = options.healthUrl
      ?? `http://127.0.0.1:${process.env.INVOKER_API_PORT ?? 4100}/api/health`;
    this.spawnInvoker = options.spawnInvoker;
    this.log = options.log;
    this.minLaunchIntervalMs = options.minLaunchIntervalMs ?? 60_000;
    this.launchHealthTimeoutMs = options.launchHealthTimeoutMs ?? 90_000;
    this.healthPollIntervalMs = options.healthPollIntervalMs ?? 2_000;
    this.pingTimeoutMs = options.pingTimeoutMs ?? 1_000;
    this.busFactory = options.busFactory ?? ((socketPath) => new IpcBus(socketPath, { allowServe: false }));
    this.now = options.now ?? (() => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.httpHealthCheck = options.httpHealthCheck ?? (() => this.defaultHttpHealth());
    this.readLockHolderPid = options.readLockHolderPid ?? defaultReadLockHolderPid;
    this.isPidAlive = options.isPidAlive ?? defaultIsPidAlive;
    this.terminatePid = options.terminatePid ?? ((pid) => process.kill(pid, 'SIGTERM'));
  }

  async ping(): Promise<boolean> {
    if (!this.bus) {
      const probe = await this.connectProbe();
      if (!probe) return false;
      this.bus = probe;
      this.healthy = true;
      this.applySubscriptions(probe);
      this.fireReconnect();
      return true;
    }
    try {
      const res = await withTimeout(
        this.bus.request<Record<string, never>, { ok?: boolean }>('headless.owner-ping', {}),
        this.pingTimeoutMs,
        () => new InvokerDownError('owner-ping timed out'),
      );
      const ok = !!res?.ok;
      if (!ok) this.markDown();
      return ok;
    } catch {
      this.markDown();
      return false;
    }
  }

  async isHealthy(): Promise<boolean> {
    if (await this.ping()) return true;
    return this.httpHealthCheck();
  }

  async listWorkflows(): Promise<WorkflowSummary[]> {
    const res = await this.query<{ workflows?: Array<{ id?: string; name?: string }> }>({ kind: 'workflows' });
    return (res.workflows ?? [])
      .filter((w): w is { id: string; name?: string } => typeof w.id === 'string')
      .map((w) => ({ id: w.id, name: w.name }));
  }

  async getWorkflowBundle(workflowId: string): Promise<WorkflowBundle> {
    const res = await this.query<WorkflowBundle>({ kind: 'workflow', workflowId });
    return { workflow: res.workflow, tasks: Array.isArray(res.tasks) ? res.tasks : [] };
  }

  async getWorkflowStatus(workflowId?: string): Promise<WorkflowStatus> {
    return this.query<WorkflowStatus>({ kind: 'workflow-status', ...(workflowId ? { workflowId } : {}) });
  }

  async getTaskOutput(taskId: string): Promise<string> {
    const res = await this.query<{ output?: string }>({ kind: 'task-output', taskId }, OUTPUT_QUERY_TIMEOUT_MS);
    return res.output ?? '';
  }

  async exec(args: string[]): Promise<void> {
    await this.ownerRequest('headless.exec', { args, noTrack: true, traceId: this.traceId('exec') }, EXEC_TIMEOUT_MS);
  }

  async run(planPath: string): Promise<{ workflowId: string; workflowIds: string[] }> {
    const res = await this.ownerRequest<{ workflowId?: string; workflowIds?: string[] }>(
      'headless.run',
      { planPath, traceId: this.traceId('run') },
      EXEC_TIMEOUT_MS,
    );
    if (!res.workflowId) throw new Error('headless.run did not return a workflowId');
    const workflowIds = Array.isArray(res.workflowIds) && res.workflowIds.length > 0
      ? res.workflowIds
      : [res.workflowId];
    return { workflowId: res.workflowId, workflowIds };
  }

  async withRecovery<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof InvokerDownError)) throw err;
      this.log('warn', `Invoker appears down (${err.message}); attempting relaunch`);
      const result = await this.launch();
      if (!result.healthy) {
        throw new InvokerDownError(
          `Invoker is down and could not be relaunched (${result.cause ?? 'unhealthy'})`,
          result.cause,
          result.holderPid,
          result.lockReadError,
        );
      }
      return fn();
    }
  }

  async launch(opts?: { force?: boolean }): Promise<LaunchResult> {
    // Coalesce concurrent callers (watchdog + command recovery) onto one launch.
    if (this.launchInFlight) return this.launchInFlight;
    this.launchInFlight = this.runLaunch(opts?.force ?? false);
    try {
      return await this.launchInFlight;
    } finally {
      this.launchInFlight = null;
    }
  }

  private async runLaunch(force: boolean): Promise<LaunchResult> {
    if (!force) {
      if (await this.ping()) return { healthy: true };
      const sinceLast = this.now() - this.lastLaunchAt;
      if (sinceLast < this.minLaunchIntervalMs) {
        this.log('warn', `launch throttled — only ${Math.round(sinceLast / 1000)}s since last launch`);
        return { healthy: false, cause: 'throttled' };
      }
    } else {
      await this.forceReclaimSplitBrainHolder();
    }
    if (await this.doLaunch()) return { healthy: true };
    const holder = this.detectUnreachableLockHolder();
    if (holder.status === 'unreachable') {
      this.lockReadUnknownStreak = 0;
      this.log('error', `relaunch failed: DB writer lock held by live, IPC-unreachable PID ${holder.pid} (split-brain)`);
      return { healthy: false, cause: 'split-brain', holderPid: holder.pid };
    }
    if (holder.status === 'unknown') {
      this.lockReadUnknownStreak += 1;
      this.log('warn', `relaunch failed: could not confirm the DB writer lock holder (${holder.detail}), streak=${this.lockReadUnknownStreak}`);
      if (this.lockReadUnknownStreak >= LOCK_READ_UNKNOWN_ALERT_STREAK) {
        this.log('error', `relaunch failed: lock holder unconfirmable for ${this.lockReadUnknownStreak} consecutive attempts (${holder.detail})`);
        return { healthy: false, cause: 'lock-unknown', lockReadError: holder.detail };
      }
      return { healthy: false, cause: 'unhealthy' };
    }
    this.lockReadUnknownStreak = 0;
    return { healthy: false, cause: 'unhealthy' };
  }

  private detectUnreachableLockHolder():
    | { status: 'none' }
    | { status: 'unreachable'; pid: number }
    | { status: 'unknown'; detail: string } {
    const read = this.readLockHolderPid();
    if (read.kind === 'error') return { status: 'unknown', detail: read.detail };
    if (read.kind === 'absent' || read.pid === process.pid) return { status: 'none' };
    return this.isPidAlive(read.pid) ? { status: 'unreachable', pid: read.pid } : { status: 'none' };
  }

  /**
   * Safety invariant: only explicit force restarts reach here, the holder is
   * re-confirmed unreachable after a fresh ping, and the signal is SIGTERM so
   * the holder's lock release() and shutdown cleanup still run.
   */
  private async forceReclaimSplitBrainHolder(): Promise<void> {
    if (await this.ping()) return;
    const holder = this.detectUnreachableLockHolder();
    if (holder.status !== 'unreachable') return;
    const holderPid = holder.pid;
    this.log('warn', `force restart: writer lock held by unreachable PID ${holderPid} — sending SIGTERM`);
    try {
      this.terminatePid(holderPid);
    } catch {
      return;
    }
    const deadline = this.now() + 10_000;
    while (this.now() < deadline && this.isPidAlive(holderPid)) {
      await this.sleep(200);
    }
    if (this.isPidAlive(holderPid)) {
      this.log('error', `force restart: PID ${holderPid} did not exit within 10s of SIGTERM`);
    }
  }

  subscribe(channel: string, handler: (message: unknown) => void): () => void {
    const entry: SubscriptionEntry = { channel, handler: handler as MessageHandler };
    this.subs.add(entry);
    if (this.bus && this.healthy) entry.unsub = this.bus.subscribe(channel, entry.handler);
    return () => {
      this.subs.delete(entry);
      entry.unsub?.();
    };
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  disconnect(): void {
    this.markDown();
    this.subs.clear();
    this.reconnectHandlers.clear();
  }

  // ── internals ───────────────────────────────────────────────

  private async doLaunch(): Promise<boolean> {
    this.lastLaunchAt = this.now();
    this.log('info', 'launching Invoker…');
    this.markDown();
    this.spawnInvoker();
    const deadline = this.now() + this.launchHealthTimeoutMs;
    while (this.now() < deadline) {
      await this.sleep(this.healthPollIntervalMs);
      if (await this.ping()) {
        this.log('info', 'Invoker is healthy');
        return true;
      }
    }
    this.log('error', `Invoker did not become healthy within ${Math.round(this.launchHealthTimeoutMs / 1000)}s`);
    return false;
  }

  private async query<T>(payload: Record<string, unknown>, timeoutMs = QUERY_TIMEOUT_MS): Promise<T> {
    return this.ownerRequest<T>('headless.query', payload, timeoutMs);
  }

  private async ownerRequest<T>(channel: string, payload: unknown, timeoutMs: number): Promise<T> {
    const bus = this.bus;
    if (!bus || !this.healthy) throw new InvokerDownError(`Invoker is not connected (channel ${channel})`);
    try {
      return await withTimeout(
        bus.request<unknown, T>(channel, payload),
        timeoutMs,
        () => new InvokerDownError(`Request ${channel} timed out`),
      );
    } catch (err) {
      if (err instanceof InvokerDownError) {
        this.markDown();
        throw err;
      }
      if (isTransportDown(err)) {
        this.markDown();
        throw new InvokerDownError(`Invoker is down: ${errMessage(err)}`);
      }
      throw err;
    }
  }

  private async connectProbe(): Promise<ConnectableBus | null> {
    const bus = this.busFactory(this.socketPath);
    try {
      await bus.ready();
      const res = await withTimeout(
        bus.request<Record<string, never>, { ok?: boolean }>('headless.owner-ping', {}),
        this.pingTimeoutMs,
        () => new InvokerDownError('owner-ping timed out'),
      );
      if (res?.ok) return bus;
    } catch {
      /* owner unreachable */
    }
    bus.disconnect();
    return null;
  }

  private applySubscriptions(bus: MessageBus): void {
    for (const entry of this.subs) {
      entry.unsub = bus.subscribe(entry.channel, entry.handler);
    }
  }

  private fireReconnect(): void {
    for (const handler of this.reconnectHandlers) {
      try {
        handler();
      } catch (err) {
        this.log('warn', `onReconnect handler failed: ${errMessage(err)}`);
      }
    }
  }

  private markDown(): void {
    if (this.bus) {
      try {
        this.bus.disconnect();
      } catch {
        /* already gone */
      }
      this.bus = null;
    }
    this.healthy = false;
  }

  private async defaultHttpHealth(): Promise<boolean> {
    try {
      const res = await withTimeout(
        fetch(this.healthUrl),
        this.pingTimeoutMs,
        () => new Error('health request timed out'),
      );
      if (!res.ok) return false;
      const body = (await res.json()) as { ok?: boolean };
      return body?.ok === true;
    } catch {
      return false;
    }
  }

  private traceId(prefix: string): string {
    return `slack-manager.${prefix}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
  }
}

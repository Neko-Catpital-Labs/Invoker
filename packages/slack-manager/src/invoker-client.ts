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

import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
  type MessageHandler,
  type Unsubscribe,
} from '@invoker/transport';
import { resolveInvokerIpcSocketPath } from '@invoker/contracts';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowStatus } from '@invoker/surfaces';

/** A MessageBus that exposes connection readiness — i.e. an IpcBus client. */
export interface ConnectableBus extends MessageBus {
  ready(): Promise<void>;
}

/** Thrown when an operation cannot reach the Invoker owner (transport-level down). */
export class InvokerDownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvokerDownError';
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
  /** Submit a plan file; resolves to the created workflow id. */
  run(planPath: string): Promise<string>;
  /** (Re)launch Invoker. Resolves true once healthy over IPC, false on timeout/throttle. */
  launch(opts?: { force?: boolean }): Promise<boolean>;
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
}

interface SubscriptionEntry {
  channel: string;
  handler: MessageHandler;
  unsub?: Unsubscribe;
}

const QUERY_TIMEOUT_MS = 5_000;
const OUTPUT_QUERY_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 60_000;

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

  private bus: ConnectableBus | null = null;
  private healthy = false;
  private lastLaunchAt = 0;
  private launchInFlight: Promise<boolean> | null = null;
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

  async run(planPath: string): Promise<string> {
    const res = await this.ownerRequest<{ workflowId?: string }>(
      'headless.run',
      { planPath, traceId: this.traceId('run') },
      EXEC_TIMEOUT_MS,
    );
    if (!res.workflowId) throw new Error('headless.run did not return a workflowId');
    return res.workflowId;
  }

  async withRecovery<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof InvokerDownError)) throw err;
      this.log('warn', `Invoker appears down (${err.message}); attempting relaunch`);
      const healthy = await this.launch();
      if (!healthy) throw new InvokerDownError('Invoker is down and could not be relaunched');
      return fn();
    }
  }

  async launch(opts?: { force?: boolean }): Promise<boolean> {
    // Coalesce concurrent callers (watchdog + command recovery) onto one launch.
    if (this.launchInFlight) return this.launchInFlight;
    this.launchInFlight = this.runLaunch(opts?.force ?? false);
    try {
      return await this.launchInFlight;
    } finally {
      this.launchInFlight = null;
    }
  }

  private async runLaunch(force: boolean): Promise<boolean> {
    if (!force) {
      if (await this.ping()) return true;
      const sinceLast = this.now() - this.lastLaunchAt;
      if (sinceLast < this.minLaunchIntervalMs) {
        this.log('warn', `launch throttled — only ${Math.round(sinceLast / 1000)}s since last launch`);
        return false;
      }
    }
    return this.doLaunch();
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

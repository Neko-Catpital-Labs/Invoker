/**
 * IpcBus — Cross-process MessageBus over Unix domain sockets.
 * Uses a deterministic socket path scoped to the Invoker home directory so
 * processes for the same DB converge on one bus, while temp/test DBs cannot
 * attach to the user's live UI.
 *
 * ## Server election
 *
 * Each IpcBus instance tries to **connect** first.  If the connection fails
 * (no server listening), it attempts to **start** the server.  If that races
 * with another process (`EADDRINUSE`), it falls back to client mode.
 * This guarantees exactly one server without external coordination.
 *
 * ## Wire format (JSON envelope, gRPC-ready)
 *
 * Every message on the socket is a length-prefixed JSON frame:
 *
 *     [4-byte big-endian uint32 length][JSON payload of that length]
 *
 * The JSON payload is an {@link Envelope}:
 *
 * ```
 * { kind: "pub",     channel: string, body: unknown }                  — publish
 * { kind: "req",     channel: string, body: unknown, reqId: string }   — request
 * { kind: "res",     channel: string, body: unknown, reqId: string }   — response
 * { kind: "err",     channel: string, code: string, message: string, reqId: string } — error response
 * ```
 *
 * The `kind` field maps 1:1 to a future gRPC `oneof` message type.
 * `reqId` is a monotonic counter per connection, unique enough for
 * in-process correlation (not globally unique).
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { mkdirSync, unlinkSync } from 'node:fs';

import type {
  MessageBus,
  MessageHandler,
  RequestHandler,
  Unsubscribe,
} from './message-bus.js';
import { resolveInvokerIpcSocketPath } from '@invoker/contracts';
import { TransportError, TransportErrorCode } from './transport-error.js';

// ---------------------------------------------------------------------------
// Wire envelope types
// ---------------------------------------------------------------------------

interface PubEnvelope {
  kind: 'pub';
  channel: string;
  body: unknown;
}

interface ReqEnvelope {
  kind: 'req';
  channel: string;
  body: unknown;
  reqId: string;
}

interface ResEnvelope {
  kind: 'res';
  channel: string;
  body: unknown;
  reqId: string;
}

interface ErrEnvelope {
  kind: 'err';
  channel: string;
  code: TransportErrorCode;
  message: string;
  reqId: string;
}

type Envelope = PubEnvelope | ReqEnvelope | ResEnvelope | ErrEnvelope;

// ---------------------------------------------------------------------------
// Length-prefixed framing helpers
// ---------------------------------------------------------------------------

/** Encode an envelope into a length-prefixed buffer. */
function encode(env: Envelope): Buffer {
  const json = Buffer.from(JSON.stringify(env), 'utf8');
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

// ---------------------------------------------------------------------------
// Malformed-frame observability
// ---------------------------------------------------------------------------

/** Structured event emitted when a frame fails to decode. */
export interface MalformedFrameEvent {
  /** ISO-8601 timestamp of the drop. */
  timestamp: string;
  /** Why the frame was rejected. */
  reason: 'invalid_json' | 'invalid_envelope';
  /** Byte length of the raw JSON payload that failed. */
  rawByteLength: number;
  /** Number of malformed frames dropped since the last emitted event
   *  (0 when every drop is reported; >0 when rate-limited). */
  droppedSinceLastReport: number;
}

/** Callback signature for malformed-frame observers. */
export type MalformedFrameObserver = (event: MalformedFrameEvent) => void;

/**
 * Default minimum interval (ms) between emitted malformed-frame events.
 * Events that arrive faster are counted but not reported until the window
 * elapses (token-bucket with capacity 1).
 */
export const MALFORMED_FRAME_RATE_LIMIT_MS = 1_000;

/**
 * Streaming decoder for length-prefixed JSON frames.
 *
 * Accumulates chunks and emits complete envelopes via the callback.
 * Stateful — one instance per socket.
 */
class FrameDecoder {
  private buf = Buffer.alloc(0);
  private readonly onEnvelope: (env: Envelope) => void;
  private readonly onMalformed: MalformedFrameObserver | undefined;
  private readonly rateLimitMs: number;

  /** Timestamp (ms) of the last emitted malformed-frame event. */
  private lastEmitMs = 0;
  /** Count of drops suppressed by rate-limiting since last emit. */
  private suppressedCount = 0;

  constructor(
    onEnvelope: (env: Envelope) => void,
    onMalformed?: MalformedFrameObserver,
    rateLimitMs: number = MALFORMED_FRAME_RATE_LIMIT_MS,
  ) {
    this.onEnvelope = onEnvelope;
    this.onMalformed = onMalformed;
    this.rateLimitMs = rateLimitMs;
  }

  push(chunk: Buffer): void {
    this.buf = Buffer.concat([this.buf, chunk]);
    // Drain as many complete frames as possible.
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break; // incomplete frame
      const json = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try {
        const parsed: unknown = JSON.parse(json);
        if (!isValidEnvelope(parsed)) {
          this.reportMalformed('invalid_envelope', Buffer.byteLength(json, 'utf8'));
          continue;
        }
        this.onEnvelope(parsed);
      } catch {
        this.reportMalformed('invalid_json', Buffer.byteLength(json, 'utf8'));
      }
    }
  }

  /** Emit a malformed-frame event, respecting the rate limit. */
  private reportMalformed(reason: MalformedFrameEvent['reason'], rawByteLength: number): void {
    if (!this.onMalformed) return;
    const now = Date.now();
    if (now - this.lastEmitMs < this.rateLimitMs) {
      this.suppressedCount++;
      return;
    }
    this.lastEmitMs = now;
    const droppedSinceLastReport = this.suppressedCount;
    this.suppressedCount = 0;
    this.onMalformed({
      timestamp: new Date(now).toISOString(),
      reason,
      rawByteLength,
      droppedSinceLastReport,
    });
  }
}

/** Type guard: returns true when the value has a valid envelope shape. */
function isValidEnvelope(v: unknown): v is Envelope {
  if (typeof v !== 'object' || v === null) return false;
  const obj = v as Record<string, unknown>;
  const kind = obj.kind;
  if (kind === 'pub') return typeof obj.channel === 'string';
  if (kind === 'req') return typeof obj.channel === 'string' && typeof obj.reqId === 'string';
  if (kind === 'res') return typeof obj.channel === 'string' && typeof obj.reqId === 'string';
  if (kind === 'err') return typeof obj.channel === 'string' && typeof obj.reqId === 'string' && typeof obj.code === 'string';
  return false;
}

// ---------------------------------------------------------------------------
// Subscriber-error observability
// ---------------------------------------------------------------------------

/** Structured event emitted when a subscriber handler throws. */
export interface SubscriberErrorEvent {
  /** ISO-8601 timestamp of the error. */
  timestamp: string;
  /** Channel the handler was subscribed to. */
  channel: string;
  /** Error message (no payload data to avoid leakage). */
  error: string;
  /** Number of handler errors suppressed since the last emitted event
   *  (0 when every error is reported; >0 when rate-limited). */
  droppedSinceLastReport: number;
}

/** Callback signature for subscriber-error observers. */
export type SubscriberErrorObserver = (event: SubscriberErrorEvent) => void;

/**
 * Default minimum interval (ms) between emitted subscriber-error events.
 * Errors that occur faster are counted but not reported until the window
 * elapses (token-bucket with capacity 1).
 */
export const SUBSCRIBER_ERROR_RATE_LIMIT_MS = 1_000;

// ---------------------------------------------------------------------------
// Default socket path
// ---------------------------------------------------------------------------

export function resolveDefaultSocketPath(): string {
  return resolveInvokerIpcSocketPath();
}

export const DEFAULT_SOCKET_PATH = resolveDefaultSocketPath();

/** Default request deadline in milliseconds (30 s). */
export const DEFAULT_REQUEST_DEADLINE_MS = 30_000;

export interface IpcBusOptions {
  allowServe?: boolean;
  /** Maximum time in ms a request may wait for a response before being
   *  rejected with `REQUEST_TIMEOUT`.  Defaults to {@link DEFAULT_REQUEST_DEADLINE_MS}. */
  requestDeadlineMs?: number;
  /** Optional callback invoked when a malformed frame is received.
   *  Rate-limited to at most one call per {@link MALFORMED_FRAME_RATE_LIMIT_MS}. */
  onMalformedFrame?: MalformedFrameObserver;
  /** Optional callback invoked when a subscriber handler throws.
   *  Rate-limited to at most one call per {@link SUBSCRIBER_ERROR_RATE_LIMIT_MS}. */
  onSubscriberError?: SubscriberErrorObserver;
}

// ---------------------------------------------------------------------------
// IpcBus
// ---------------------------------------------------------------------------

export class IpcBus implements MessageBus {
  private readonly socketPath: string;
  private readonly allowServe: boolean;
  private readonly requestDeadlineMs: number;
  private readonly onMalformedFrame: MalformedFrameObserver | undefined;
  private readonly onSubscriberError: SubscriberErrorObserver | undefined;

  /** Timestamp (ms) of the last emitted subscriber-error event. */
  private subscriberErrorLastEmitMs = 0;
  /** Count of subscriber errors suppressed by rate-limiting since last emit. */
  private subscriberErrorSuppressedCount = 0;

  // Local handler registries (same structure as LocalBus).
  private subscribers = new Map<string, Set<MessageHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();

  // Networking state.
  private server: Server | null = null;
  private serveRetryScheduled = false;
  /** All connected peer sockets (clients when we are server, or just the
   *  single server socket when we are client). */
  private peers = new Set<Socket>();
  private readyPromise: Promise<void>;
  private resolveReady!: () => void;
  private disconnected = false;

  // Request/reply correlation.
  private nextReqId = 0;
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();
  private relayedRequests = new Map<
    string,
    { source: Socket; awaiting: Set<Socket>; channel: string }
  >();

  constructor(socketPath: string = resolveDefaultSocketPath(), options: IpcBusOptions = {}) {
    this.socketPath = socketPath;
    this.allowServe = options.allowServe ?? true;
    this.requestDeadlineMs = options.requestDeadlineMs ?? DEFAULT_REQUEST_DEADLINE_MS;
    this.onMalformedFrame = options.onMalformedFrame;
    this.onSubscriberError = options.onSubscriberError;
    this.readyPromise = new Promise<void>((r) => {
      this.resolveReady = r;
    });
    this.init();
  }

  // ------------------------------------------------------------------
  // Initialisation: try connect → try serve → fallback connect
  // ------------------------------------------------------------------

  private init(): void {
    this.tryConnect();
  }

  private tryConnect(): void {
    const sock = createConnection({ path: this.socketPath }, () => {
      // Connected as client.
      this.addPeer(sock);
      this.resolveReady();
    });

    sock.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'ECONNREFUSED' || err.code === 'ENOENT') {
        if (!this.allowServe) {
          this.resolveReady();
          return;
        }
        // No server yet — try to become the server.
        this.tryServe();
      } else {
        if (!this.allowServe) {
          this.resolveReady();
          return;
        }
        // Unexpected error — still try to serve.
        this.tryServe();
      }
    });
  }

  private tryServe(): void {
    // Ensure directory exists.
    mkdirSync(dirname(this.socketPath), { recursive: true });

    // Clean stale socket file before binding.
    try {
      unlinkSync(this.socketPath);
    } catch {
      // File may not exist — fine.
    }

    const srv = createServer((client) => {
      this.addPeer(client);
    });

    srv.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        // Another process won the race — fall back to client.
        this.tryConnectRetry();
      }
      // Other server errors are silently ignored (no payload logging).
    });

    srv.listen(this.socketPath, () => {
      this.server = srv;
      this.resolveReady();
    });
  }

  /** Retry connect after losing the serve race. */
  private tryConnectRetry(): void {
    const sock = createConnection({ path: this.socketPath }, () => {
      this.addPeer(sock);
      this.resolveReady();
    });

    sock.on('error', () => {
      if (this.allowServe) {
        this.scheduleServeRecovery();
      }
      // Nothing else we can do synchronously — resolve ready so callers don't hang forever.
      this.resolveReady();
    });
  }

  private scheduleServeRecovery(): void {
    if (this.disconnected || !this.allowServe || this.server || this.peers.size > 0 || this.serveRetryScheduled) {
      return;
    }
    this.serveRetryScheduled = true;
    setTimeout(() => {
      this.serveRetryScheduled = false;
      if (this.disconnected || !this.allowServe || this.server || this.peers.size > 0) {
        return;
      }
      this.tryServe();
    }, 25).unref?.();
  }

  // ------------------------------------------------------------------
  // Peer management
  // ------------------------------------------------------------------

  private addPeer(sock: Socket): void {
    if (this.disconnected) {
      sock.destroy();
      return;
    }
    this.peers.add(sock);
    const decoder = new FrameDecoder(
      (env) => this.handleEnvelope(env, sock),
      this.onMalformedFrame,
    );
    sock.on('data', (chunk: Buffer) => decoder.push(chunk));
    sock.on('close', () => {
      this.peers.delete(sock);
      this.scheduleServeRecovery();
    });
    sock.on('error', () => {
      sock.destroy();
      this.peers.delete(sock);
      this.scheduleServeRecovery();
    });
  }

  // ------------------------------------------------------------------
  // Envelope handling
  // ------------------------------------------------------------------

  private handleEnvelope(env: Envelope, source: Socket): void {
    switch (env.kind) {
      case 'pub':
        // If we are the server, broadcast to all other peers.
        if (this.server) {
          this.broadcastExcept(env, source);
        }
        // Deliver locally.
        this.deliverLocally(env.channel, env.body);
        break;

      case 'req':
        this.handleRequest(env, source);
        break;

      case 'res':
      case 'err':
        this.handleResponse(env, source);
        break;
    }
  }

  private deliverLocally(channel: string, body: unknown): void {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try {
        handler(body);
      } catch (e) {
        // Swallow handler errors — same behaviour as LocalBus.
        this.reportSubscriberError(
          channel,
          e instanceof Error ? e.message : String(e),
        );
      }
    }
  }

  /** Emit a subscriber-error event, respecting the rate limit. */
  private reportSubscriberError(channel: string, error: string): void {
    if (!this.onSubscriberError) return;
    const now = Date.now();
    if (now - this.subscriberErrorLastEmitMs < SUBSCRIBER_ERROR_RATE_LIMIT_MS) {
      this.subscriberErrorSuppressedCount++;
      return;
    }
    this.subscriberErrorLastEmitMs = now;
    const droppedSinceLastReport = this.subscriberErrorSuppressedCount;
    this.subscriberErrorSuppressedCount = 0;
    this.onSubscriberError({
      timestamp: new Date(now).toISOString(),
      channel,
      error,
      droppedSinceLastReport,
    });
  }

  private async handleRequest(env: ReqEnvelope, source: Socket): Promise<void> {
    const handler = this.requestHandlers.get(env.channel);
    if (!handler) {
      if (this.server) {
        const peersToQuery = new Set(
          [...this.peers].filter((peer) => peer !== source && !peer.destroyed),
        );
        if (peersToQuery.size > 0) {
          this.relayedRequests.set(env.reqId, {
            source,
            awaiting: peersToQuery,
            channel: env.channel,
          });
          this.broadcastExcept(env, source);
          return;
        }
      }
      const errEnv: ErrEnvelope = {
        kind: 'err',
        channel: env.channel,
        code: TransportErrorCode.NO_HANDLER,
        message: `No request handler registered for channel: ${env.channel}`,
        reqId: env.reqId,
      };
      this.sendToSocket(source, errEnv);
      return;
    }
    try {
      const result = await handler(env.body);
      const resEnv: ResEnvelope = {
        kind: 'res',
        channel: env.channel,
        body: result,
        reqId: env.reqId,
      };
      this.sendToSocket(source, resEnv);
    } catch (e) {
      const errEnv: ErrEnvelope = {
        kind: 'err',
        channel: env.channel,
        code: e instanceof TransportError ? e.code : TransportErrorCode.HANDLER_ERROR,
        message: e instanceof Error ? e.message : String(e),
        reqId: env.reqId,
      };
      this.sendToSocket(source, errEnv);
    }
  }

  private handleResponse(env: ResEnvelope | ErrEnvelope, source: Socket): void {
    const pending = this.pendingRequests.get(env.reqId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(env.reqId);
      if (env.kind === 'res') {
        pending.resolve(env.body);
      } else {
        pending.reject(new TransportError(env.code ?? TransportErrorCode.HANDLER_ERROR, env.message));
      }
      return;
    }
    this.handleRelayedResponse(env, source);
  }

  private handleRelayedResponse(env: ResEnvelope | ErrEnvelope, source: Socket): boolean {
    const relay = this.relayedRequests.get(env.reqId);
    if (!relay) return false;

    if (env.kind === 'res') {
      this.relayedRequests.delete(env.reqId);
      this.sendToSocket(relay.source, env);
      return true;
    }

    relay.awaiting.delete(source);
    const noHandlerError = env.code === TransportErrorCode.NO_HANDLER;
    if (!noHandlerError || relay.awaiting.size === 0) {
      this.relayedRequests.delete(env.reqId);
      this.sendToSocket(relay.source, env);
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Sending helpers
  // ------------------------------------------------------------------

  private sendToSocket(sock: Socket, env: Envelope): void {
    if (!sock.destroyed) {
      sock.write(encode(env));
    }
  }

  private broadcastExcept(env: Envelope, except: Socket): void {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (peer !== except && !peer.destroyed) {
        peer.write(frame);
      }
    }
  }

  private sendToAll(env: Envelope): void {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (!peer.destroyed) {
        peer.write(frame);
      }
    }
  }

  // ------------------------------------------------------------------
  // MessageBus interface
  // ------------------------------------------------------------------

  subscribe<T>(channel: string, handler: MessageHandler<T>): Unsubscribe {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    const handlers = this.subscribers.get(channel)!;
    handlers.add(handler as MessageHandler);

    return () => {
      handlers.delete(handler as MessageHandler);
      if (handlers.size === 0) {
        this.subscribers.delete(channel);
      }
    };
  }

  publish<T>(channel: string, message: T): void {
    // Deliver locally immediately.
    this.deliverLocally(channel, message);

    // Send to peers (fire-and-forget).
    const env: PubEnvelope = { kind: 'pub', channel, body: message };
    this.sendToAll(env);
  }

  onRequest<Req, Res>(channel: string, handler: RequestHandler<Req, Res>): Unsubscribe {
    this.requestHandlers.set(channel, handler as RequestHandler);
    return () => {
      this.requestHandlers.delete(channel);
    };
  }

  async request<Req, Res>(channel: string, message: Req): Promise<Res> {
    // Try local handler first.
    const localHandler = this.requestHandlers.get(channel);
    if (localHandler) {
      return localHandler(message) as Promise<Res>;
    }

    // Forward to a peer (first available).
    await this.readyPromise;

    // If no peers are connected, reject immediately — no one can handle this.
    const livePeers = [...this.peers].filter((p) => !p.destroyed);
    if (livePeers.length === 0) {
      throw new TransportError(
        TransportErrorCode.NO_HANDLER,
        `No request handler registered for channel: ${channel}`,
      );
    }

    const reqId = String(this.nextReqId++);
    const env: ReqEnvelope = { kind: 'req', channel, body: message, reqId };

    return new Promise<Res>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pendingRequests.delete(reqId)) {
          reject(new TransportError(
            TransportErrorCode.REQUEST_TIMEOUT,
            `Request on channel "${channel}" timed out after ${this.requestDeadlineMs}ms`,
          ));
        }
      }, this.requestDeadlineMs);
      timer.unref?.();

      this.pendingRequests.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
        timer,
      });
      // Send to all peers — only the one with a handler will reply.
      this.sendToAll(env);
    });
  }

  /** Wait until the transport is connected or serving. */
  ready(): Promise<void> {
    return this.readyPromise;
  }

  disconnect(): void {
    this.disconnected = true;
    this.subscribers.clear();
    this.requestHandlers.clear();

    // Reject all pending requests and clear their deadline timers.
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new TransportError(TransportErrorCode.DISCONNECTED, 'IpcBus disconnected'));
    }
    this.pendingRequests.clear();

    // Close all peer sockets.
    for (const peer of this.peers) {
      peer.destroy();
    }
    this.peers.clear();

    // Close server if we own it.
    if (this.server) {
      this.server.close();
      // Remove socket file.
      try {
        unlinkSync(this.socketPath);
      } catch {
        // May already be removed.
      }
      this.server = null;
    }
  }
}

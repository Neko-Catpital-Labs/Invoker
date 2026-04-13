/**
 * IpcBus — Cross-process MessageBus over Unix domain sockets.
 *
 * Uses a deterministic socket path (`~/.invoker/ipc-transport.sock`) so all
 * processes in the same user session converge on a single bus without
 * discovery.
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
 * { kind: "err",     channel: string, message: string, reqId: string } — error response
 * ```
 *
 * The `kind` field maps 1:1 to a future gRPC `oneof` message type.
 * `reqId` is a monotonic counter per connection, unique enough for
 * in-process correlation (not globally unique).
 */

import { createServer, createConnection, type Server, type Socket } from 'node:net';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { mkdirSync, unlinkSync } from 'node:fs';

import type {
  MessageBus,
  MessageHandler,
  RequestHandler,
  Unsubscribe,
} from './message-bus.js';

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

/**
 * Streaming decoder for length-prefixed JSON frames.
 *
 * Accumulates chunks and emits complete envelopes via the callback.
 * Stateful — one instance per socket.
 */
class FrameDecoder {
  private buf = Buffer.alloc(0);
  private onEnvelope: (env: Envelope) => void;

  constructor(onEnvelope: (env: Envelope) => void) {
    this.onEnvelope = onEnvelope;
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
        this.onEnvelope(JSON.parse(json) as Envelope);
      } catch {
        // Malformed frame — skip silently (no payload logging).
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Default socket path
// ---------------------------------------------------------------------------

export const DEFAULT_SOCKET_PATH =
  process.env.INVOKER_IPC_SOCKET || join(homedir(), '.invoker', 'ipc-transport.sock');

export interface IpcBusOptions {
  allowServe?: boolean;
}

// ---------------------------------------------------------------------------
// IpcBus
// ---------------------------------------------------------------------------

export class IpcBus implements MessageBus {
  private readonly socketPath: string;
  private readonly allowServe: boolean;

  // Local handler registries (same structure as LocalBus).
  private subscribers = new Map<string, Set<MessageHandler>>();
  private requestHandlers = new Map<string, RequestHandler>();

  // Networking state.
  private server: Server | null = null;
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
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  private relayedRequests = new Map<
    string,
    { source: Socket; awaiting: Set<Socket>; channel: string }
  >();

  constructor(socketPath: string = DEFAULT_SOCKET_PATH, options: IpcBusOptions = {}) {
    this.socketPath = socketPath;
    this.allowServe = options.allowServe ?? true;
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
      // Nothing we can do — resolve ready so callers don't hang forever.
      this.resolveReady();
    });
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
    const decoder = new FrameDecoder((env) => this.handleEnvelope(env, sock));
    sock.on('data', (chunk: Buffer) => decoder.push(chunk));
    sock.on('close', () => this.peers.delete(sock));
    sock.on('error', () => {
      sock.destroy();
      this.peers.delete(sock);
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
      } catch {
        // Swallow handler errors — same behaviour as LocalBus.
      }
    }
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
        message: e instanceof Error ? e.message : String(e),
        reqId: env.reqId,
      };
      this.sendToSocket(source, errEnv);
    }
  }

  private handleResponse(env: ResEnvelope | ErrEnvelope, source: Socket): void {
    const pending = this.pendingRequests.get(env.reqId);
    if (pending) {
      this.pendingRequests.delete(env.reqId);
      if (env.kind === 'res') {
        pending.resolve(env.body);
      } else {
        pending.reject(new Error(env.message));
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
    const noHandlerError = env.message === `No request handler registered for channel: ${relay.channel}`;
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

    const reqId = String(this.nextReqId++);
    const env: ReqEnvelope = { kind: 'req', channel, body: message, reqId };

    return new Promise<Res>((resolve, reject) => {
      this.pendingRequests.set(reqId, {
        resolve: resolve as (v: unknown) => void,
        reject,
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

    // Reject all pending requests.
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error('IpcBus disconnected'));
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

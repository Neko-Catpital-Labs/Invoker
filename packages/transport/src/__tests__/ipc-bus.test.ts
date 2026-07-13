import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { existsSync, mkdtempSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createConnection } from 'node:net';
import {
  IpcBus,
  DEFAULT_REQUEST_DEADLINE_MS,
  MALFORMED_FRAME_RATE_LIMIT_MS,
  resolveDefaultSocketPath,
  type MalformedFrameEvent,
} from '../ipc-bus.js';
import { TransportError, TransportErrorCode } from '../transport-error.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/**
 * Each test gets its own socket path in a temp directory to avoid
 * conflicts between parallel test runs.
 */
function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ipc-bus-test-'));
  return join(dir, 'test.sock');
}

describe('resolveDefaultSocketPath', () => {
  const originalInvokerDbDir = process.env.INVOKER_DB_DIR;
  const originalInvokerIpcSocket = process.env.INVOKER_IPC_SOCKET;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    if (originalInvokerDbDir === undefined) {
      delete process.env.INVOKER_DB_DIR;
    } else {
      process.env.INVOKER_DB_DIR = originalInvokerDbDir;
    }
    if (originalInvokerIpcSocket === undefined) {
      delete process.env.INVOKER_IPC_SOCKET;
    } else {
      process.env.INVOKER_IPC_SOCKET = originalInvokerIpcSocket;
    }
    if (originalNodeEnv === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = originalNodeEnv;
    }
  });

  it('scopes the default socket to INVOKER_DB_DIR', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-ipc-root-'));
    process.env.INVOKER_DB_DIR = dir;
    delete process.env.INVOKER_IPC_SOCKET;

    expect(resolveDefaultSocketPath()).toBe(join(dir, 'ipc-transport.sock'));
  });

  it('keeps explicit INVOKER_IPC_SOCKET as the strongest override', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-ipc-root-'));
    const socket = join(dir, 'custom.sock');
    process.env.INVOKER_DB_DIR = dir;
    process.env.INVOKER_IPC_SOCKET = socket;

    expect(resolveDefaultSocketPath()).toBe(socket);
  });

  it('keeps test mode away from the live Invoker socket when no DB dir is set', () => {
    delete process.env.INVOKER_DB_DIR;
    delete process.env.INVOKER_IPC_SOCKET;
    process.env.NODE_ENV = 'test';

    expect(resolveDefaultSocketPath()).toBe(join(homedir(), '.invoker', 'test', 'ipc-transport.sock'));
  });
});

describe('IpcBus', () => {
  const buses: IpcBus[] = [];

  function createBus(socketPath: string): IpcBus {
    const bus = new IpcBus(socketPath);
    buses.push(bus);
    return bus;
  }

  afterEach(() => {
    for (const bus of buses) {
      bus.disconnect();
    }
    buses.length = 0;
  });

  // ---------------------------------------------------------------
  // Single-instance (local delivery)
  // ---------------------------------------------------------------

  it('local publish/subscribe delivers messages', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    const received: string[] = [];
    bus.subscribe('test', (msg: string) => received.push(msg));
    bus.publish('test', 'hello');

    expect(received).toEqual(['hello']);
  });

  it('unsubscribe stops local delivery', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    const received: string[] = [];
    const unsub = bus.subscribe('test', (msg: string) => received.push(msg));

    bus.publish('test', 'first');
    unsub();
    bus.publish('test', 'second');

    expect(received).toEqual(['first']);
  });

  it('multiple local subscribers on same channel', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    const a: string[] = [];
    const b: string[] = [];
    bus.subscribe('ch', (msg: string) => a.push(msg));
    bus.subscribe('ch', (msg: string) => b.push(msg));

    bus.publish('ch', 'data');

    expect(a).toEqual(['data']);
    expect(b).toEqual(['data']);
  });

  it('local request/reply works', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    bus.onRequest<number, number>('double', (n) => n * 2);
    const result = await bus.request<number, number>('double', 5);
    expect(result).toBe(10);
  });

  it('publish to empty channel does not error', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    expect(() => bus.publish('empty', 'data')).not.toThrow();
  });

  it('disconnect cleans up subscriptions', async () => {
    const sock = tempSocketPath();
    const bus = createBus(sock);
    await bus.ready();

    const received: string[] = [];
    bus.subscribe('test', (msg: string) => received.push(msg));
    bus.onRequest('rpc', () => 42);

    bus.disconnect();

    bus.publish('test', 'after');
    expect(received).toEqual([]);
  });

  // ---------------------------------------------------------------
  // Cross-instance (two IpcBus instances on the same socket)
  // ---------------------------------------------------------------

  it('cross-instance pub/sub: server publishes, client receives', async () => {
    const sock = tempSocketPath();

    // First bus becomes server.
    const server = createBus(sock);
    await server.ready();

    // Second bus connects as client.
    const client = createBus(sock);
    await client.ready();

    // Brief delay for the TCP handshake to fully settle.
    await sleep(50);

    const received: string[] = [];
    client.subscribe('ch', (msg: string) => received.push(msg));

    server.publish('ch', 'from-server');

    // Cross-process delivery is async (socket write/read cycle).
    await waitFor(() => received.length >= 1, 2000);

    expect(received).toEqual(['from-server']);
  });

  it('cross-instance pub/sub: client publishes, server receives', async () => {
    const sock = tempSocketPath();

    const server = createBus(sock);
    await server.ready();

    const client = createBus(sock);
    await client.ready();

    await sleep(50);

    const received: string[] = [];
    server.subscribe('ch', (msg: string) => received.push(msg));

    client.publish('ch', 'from-client');

    await waitFor(() => received.length >= 1, 2000);

    expect(received).toEqual(['from-client']);
  });

  it('cross-instance pub/sub: broadcast to multiple clients', async () => {
    const sock = tempSocketPath();

    const server = createBus(sock);
    await server.ready();

    const clientA = createBus(sock);
    const clientB = createBus(sock);
    await clientA.ready();
    await clientB.ready();

    await sleep(50);

    const receivedA: string[] = [];
    const receivedB: string[] = [];
    clientA.subscribe('ch', (msg: string) => receivedA.push(msg));
    clientB.subscribe('ch', (msg: string) => receivedB.push(msg));

    server.publish('ch', 'broadcast');

    await waitFor(() => receivedA.length >= 1 && receivedB.length >= 1, 2000);

    expect(receivedA).toEqual(['broadcast']);
    expect(receivedB).toEqual(['broadcast']);
  });

  it('cross-instance pub/sub: client-to-client via server relay', async () => {
    const sock = tempSocketPath();

    const server = createBus(sock);
    await server.ready();

    const clientA = createBus(sock);
    const clientB = createBus(sock);
    await clientA.ready();
    await clientB.ready();

    await sleep(50);

    const received: string[] = [];
    clientB.subscribe('ch', (msg: string) => received.push(msg));

    clientA.publish('ch', 'relayed');

    await waitFor(() => received.length >= 1, 2000);

    expect(received).toEqual(['relayed']);
  });

  it('cross-instance request/reply', async () => {
    const sock = tempSocketPath();

    const server = createBus(sock);
    await server.ready();

    // Handler on server side.
    server.onRequest<number, number>('triple', (n) => n * 3);

    const client = createBus(sock);
    await client.ready();

    await sleep(50);

    const result = await client.request<number, number>('triple', 4);
    expect(result).toBe(12);
  });

  it('cross-instance request/reply relays through a server without a handler', async () => {
    const sock = tempSocketPath();

    const relayServer = createBus(sock);
    await relayServer.ready();

    const requester = createBus(sock);
    const owner = createBus(sock);
    await requester.ready();
    await owner.ready();

    await sleep(50);

    owner.onRequest<number, number>('triple', (n) => n * 3);

    const result = await requester.request<number, number>('triple', 4);
    expect(result).toBe(12);
  });

  it('client-only buses never steal server ownership', async () => {
    const sock = tempSocketPath();

    const clientOnly = new IpcBus(sock, { allowServe: false });
    buses.push(clientOnly);
    await clientOnly.ready();

    const owner = createBus(sock);
    await owner.ready();
    owner.onRequest<string, string>('echo', (value) => `owner:${value}`);

    const requester = new IpcBus(sock, { allowServe: false });
    buses.push(requester);
    await requester.ready();

    await sleep(50);

    const result = await requester.request<string, string>('echo', 'ok');
    expect(result).toBe('owner:ok');
  });

  it('ignores no-handler responses from other peers when one peer can satisfy the request', async () => {
    const sock = tempSocketPath();

    const relayServer = createBus(sock);
    await relayServer.ready();

    const requester = createBus(sock);
    const idlePeer = createBus(sock);
    const owner = createBus(sock);
    await requester.ready();
    await idlePeer.ready();
    await owner.ready();

    await sleep(50);

    owner.onRequest<number, number>('delayed-double', async (n) => {
      await sleep(25);
      return n * 2;
    });

    const result = await requester.request<number, number>('delayed-double', 5);
    expect(result).toBe(10);
  });

  // ---------------------------------------------------------------
  // Request deadline
  // ---------------------------------------------------------------

  it('rejects with REQUEST_TIMEOUT when no response arrives within the deadline', async () => {
    const sock = tempSocketPath();

    const server = new IpcBus(sock, { requestDeadlineMs: 100 });
    buses.push(server);
    await server.ready();

    // Register a handler that never resolves.
    server.onRequest('black-hole', () => new Promise(() => {}));

    const client = new IpcBus(sock, { requestDeadlineMs: 100 });
    buses.push(client);
    await client.ready();
    await sleep(50);

    try {
      await client.request('black-hole', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.REQUEST_TIMEOUT);
      expect((err as TransportError).message).toContain('black-hole');
      expect((err as TransportError).message).toContain('100ms');
    }
  });

  it('does not timeout when response arrives before the deadline', async () => {
    const sock = tempSocketPath();

    const server = new IpcBus(sock, { requestDeadlineMs: 500 });
    buses.push(server);
    await server.ready();

    server.onRequest<number, number>('fast', (n) => n + 1);

    const client = new IpcBus(sock, { requestDeadlineMs: 500 });
    buses.push(client);
    await client.ready();
    await sleep(50);

    const result = await client.request<number, number>('fast', 41);
    expect(result).toBe(42);
  });

  it('disconnect rejects with DISCONNECTED, not REQUEST_TIMEOUT', async () => {
    const sock = tempSocketPath();

    const server = new IpcBus(sock, { requestDeadlineMs: 2000 });
    buses.push(server);
    await server.ready();

    server.onRequest('never-reply', () => new Promise(() => {}));

    const client = new IpcBus(sock, { requestDeadlineMs: 2000 });
    buses.push(client);
    await client.ready();
    await sleep(50);

    const requestPromise = client.request('never-reply', {});
    await sleep(20);
    client.disconnect();

    try {
      await requestPromise;
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.DISCONNECTED);
    }
  });

  it('rejects immediately with NO_HANDLER when no local handler and no peers', async () => {
    const sock = tempSocketPath();

    const bus = createBus(sock);
    await bus.ready();

    try {
      await bus.request('unhandled-channel', { data: 1 });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.NO_HANDLER);
      expect((err as TransportError).message).toContain('unhandled-channel');
    }
  });

  it('exports DEFAULT_REQUEST_DEADLINE_MS as 30000', () => {
    expect(DEFAULT_REQUEST_DEADLINE_MS).toBe(30_000);
  });

  // ---------------------------------------------------------------
  // Server election race
  // ---------------------------------------------------------------

  it('two buses on the same path both become ready', async () => {
    const sock = tempSocketPath();

    // Start both simultaneously to exercise the election race.
    const busA = createBus(sock);
    const busB = createBus(sock);

    await Promise.all([busA.ready(), busB.ready()]);

    // Both should be functional for local delivery at minimum.
    const received: string[] = [];
    busA.subscribe('ch', (msg: string) => received.push(msg));
    busA.publish('ch', 'ok');
    expect(received).toEqual(['ok']);
  });

  it('surviving client reclaims the socket after the original server disappears', async () => {
    const sock = tempSocketPath();

    const originalServer = createBus(sock);
    await originalServer.ready();

    const survivingOwner = createBus(sock);
    await survivingOwner.ready();
    await sleep(50);

    survivingOwner.onRequest<string, string>('echo', (value) => `owner:${value}`);

    originalServer.disconnect();

    await waitFor(() => existsSync(sock), 2000);
    await sleep(100);

    const requester = new IpcBus(sock, { allowServe: false });
    buses.push(requester);
    await requester.ready();
    await sleep(50);

    const result = await requester.request<string, string>('echo', 'ok');
    expect(result).toBe('owner:ok');
  });

  // ---------------------------------------------------------------
  // Cross-process communication (actual separate Node processes)
  // ---------------------------------------------------------------

  it('cross-process: A subscribes, B publishes', async () => {
    const sock = tempSocketPath();

    // Minimal IpcBus implementation in plain JS (subset needed for cross-process test)
    const minimalIpcBusJS = `
const { createServer, createConnection } = require('node:net');
const { dirname } = require('node:path');
const { mkdirSync, unlinkSync } = require('node:fs');

function encode(env) {
  const json = Buffer.from(JSON.stringify(env), 'utf8');
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  constructor(onEnvelope) {
    this.buf = Buffer.alloc(0);
    this.onEnvelope = onEnvelope;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onEnvelope(JSON.parse(json));
      } catch (e) {}
    }
  }
}

class IpcBus {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.subscribers = new Map();
    this.requestHandlers = new Map();
    this.server = null;
    this.peers = new Set();
    this.disconnected = false;
    this.nextReqId = 0;
    this.pendingRequests = new Map();
    this.readyPromise = new Promise((r) => { this.resolveReady = r; });
    this.init();
  }
  init() {
    this.tryConnect();
  }
  tryConnect() {
    const sock = createConnection({ path: this.socketPath }, () => {
      this.addPeer(sock);
      this.resolveReady();
    });
    sock.on('error', () => { this.tryServe(); });
  }
  tryServe() {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    try { unlinkSync(this.socketPath); } catch (e) {}
    const srv = createServer((client) => { this.addPeer(client); });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') { this.tryConnectRetry(); }
    });
    srv.listen(this.socketPath, () => {
      this.server = srv;
      this.resolveReady();
    });
  }
  tryConnectRetry() {
    const sock = createConnection({ path: this.socketPath }, () => {
      this.addPeer(sock);
      this.resolveReady();
    });
    sock.on('error', () => { this.resolveReady(); });
  }
  addPeer(sock) {
    if (this.disconnected) {
      sock.destroy();
      return;
    }
    this.peers.add(sock);
    const decoder = new FrameDecoder((env) => this.handleEnvelope(env, sock));
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('close', () => this.peers.delete(sock));
    sock.on('error', () => {
      sock.destroy();
      this.peers.delete(sock);
    });
  }
  handleEnvelope(env, source) {
    if (env.kind === 'pub') {
      if (this.server) { this.broadcastExcept(env, source); }
      this.deliverLocally(env.channel, env.body);
    }
  }
  deliverLocally(channel, body) {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(body); } catch (e) {}
    }
  }
  broadcastExcept(env, except) {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (peer !== except && !peer.destroyed) { peer.write(frame); }
    }
  }
  sendToAll(env) {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (!peer.destroyed) { peer.write(frame); }
    }
  }
  subscribe(channel, handler) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    const handlers = this.subscribers.get(channel);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) { this.subscribers.delete(channel); }
    };
  }
  publish(channel, message) {
    this.deliverLocally(channel, message);
    const env = { kind: 'pub', channel, body: message };
    this.sendToAll(env);
  }
  ready() {
    return this.readyPromise;
  }
}
`;

    // Build subscriber script
    const subscriberCode = `
${minimalIpcBusJS}

(async () => {
  const bus = new IpcBus('${sock}');
  await bus.ready();
  // Small delay to ensure socket connection is fully established
  await new Promise(r => setTimeout(r, 50));
  bus.subscribe('task.delta', (msg) => {
    if (msg && msg.type === 'sentinel') {
      process.send({ received: true });
    }
  });
  process.send({ ready: true });
})().catch((e) => {
  process.send({ error: e.message });
  process.exit(1);
});
`;

    // Build publisher script
    const publisherCode = `
${minimalIpcBusJS}

(async () => {
  const bus = new IpcBus('${sock}');
  await bus.ready();
  // Small delay to ensure socket connection is fully established
  await new Promise(r => setTimeout(r, 50));
  // Publish a few times to avoid startup-race drops during cross-process handshake.
  for (let i = 0; i < 5; i++) {
    bus.publish('task.delta', { type: 'sentinel', data: 'hello' });
    await new Promise(r => setTimeout(r, 30));
  }
  process.send({ published: true });
})().catch((e) => {
  process.send({ error: e.message });
  process.exit(1);
});
`;

    // Spawn subscriber first
    const procA = spawn('node', ['-e', subscriberCode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Collect messages and stderr from subscriber
    const messages: { a: any[]; b: any[] } = { a: [], b: [] };
    let stderrA = '';
    let stderrB = '';
    let resolveTest: () => void;
    const testPromise = new Promise<void>((r) => { resolveTest = r; });

    procA.stderr?.on('data', (chunk) => { stderrA += chunk.toString(); });

    procA.on('message', (msg: any) => {
      messages.a.push(msg);
      if (msg.received) {
        resolveTest();
      }
    });

    // Wait for subscriber to be ready before starting publisher
    try {
      await waitFor(() => messages.a.some((m: any) => m.ready), 2000);
    } catch (e) {
      console.error('Process A stderr:', stderrA);
      throw e;
    }

    // Now spawn publisher after subscriber is ready
    const procB = spawn('node', ['-e', publisherCode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    procB.stderr?.on('data', (chunk) => { stderrB += chunk.toString(); });

    procB.on('message', (msg: any) => {
      messages.b.push(msg);
    });

    // Wait for the sentinel message to be received
    await Promise.race([
      testPromise,
      sleep(3000).then(() => {
        console.error('Process A stderr:', stderrA);
        console.error('Process B stderr:', stderrB);
        throw new Error('Test timed out waiting for cross-process message');
      }),
    ]);

    // Clean up
    procA.kill();
    procB.kill();

    expect(messages.a.some((m: any) => m.received)).toBe(true);
    expect(messages.b.some((m: any) => m.error)).toBe(false);
  }, 10000);

  it('cross-process: B subscribes, A publishes (reversed)', async () => {
    const sock = tempSocketPath();

    // Minimal IpcBus implementation in plain JS (subset needed for cross-process test)
    const minimalIpcBusJS = `
const { createServer, createConnection } = require('node:net');
const { dirname } = require('node:path');
const { mkdirSync, unlinkSync } = require('node:fs');

function encode(env) {
  const json = Buffer.from(JSON.stringify(env), 'utf8');
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  constructor(onEnvelope) {
    this.buf = Buffer.alloc(0);
    this.onEnvelope = onEnvelope;
  }
  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) break;
      const json = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      try {
        this.onEnvelope(JSON.parse(json));
      } catch (e) {}
    }
  }
}

class IpcBus {
  constructor(socketPath) {
    this.socketPath = socketPath;
    this.subscribers = new Map();
    this.requestHandlers = new Map();
    this.server = null;
    this.peers = new Set();
    this.disconnected = false;
    this.nextReqId = 0;
    this.pendingRequests = new Map();
    this.readyPromise = new Promise((r) => { this.resolveReady = r; });
    this.init();
  }
  init() {
    this.tryConnect();
  }
  tryConnect() {
    const sock = createConnection({ path: this.socketPath }, () => {
      this.addPeer(sock);
      this.resolveReady();
    });
    sock.on('error', () => { this.tryServe(); });
  }
  tryServe() {
    mkdirSync(dirname(this.socketPath), { recursive: true });
    try { unlinkSync(this.socketPath); } catch (e) {}
    const srv = createServer((client) => { this.addPeer(client); });
    srv.on('error', (err) => {
      if (err.code === 'EADDRINUSE') { this.tryConnectRetry(); }
    });
    srv.listen(this.socketPath, () => {
      this.server = srv;
      this.resolveReady();
    });
  }
  tryConnectRetry() {
    const sock = createConnection({ path: this.socketPath }, () => {
      this.addPeer(sock);
      this.resolveReady();
    });
    sock.on('error', () => { this.resolveReady(); });
  }
  addPeer(sock) {
    if (this.disconnected) {
      sock.destroy();
      return;
    }
    this.peers.add(sock);
    const decoder = new FrameDecoder((env) => this.handleEnvelope(env, sock));
    sock.on('data', (chunk) => decoder.push(chunk));
    sock.on('close', () => this.peers.delete(sock));
    sock.on('error', () => {
      sock.destroy();
      this.peers.delete(sock);
    });
  }
  handleEnvelope(env, source) {
    if (env.kind === 'pub') {
      if (this.server) { this.broadcastExcept(env, source); }
      this.deliverLocally(env.channel, env.body);
    }
  }
  deliverLocally(channel, body) {
    const handlers = this.subscribers.get(channel);
    if (!handlers) return;
    for (const handler of handlers) {
      try { handler(body); } catch (e) {}
    }
  }
  broadcastExcept(env, except) {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (peer !== except && !peer.destroyed) { peer.write(frame); }
    }
  }
  sendToAll(env) {
    const frame = encode(env);
    for (const peer of this.peers) {
      if (!peer.destroyed) { peer.write(frame); }
    }
  }
  subscribe(channel, handler) {
    if (!this.subscribers.has(channel)) {
      this.subscribers.set(channel, new Set());
    }
    const handlers = this.subscribers.get(channel);
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
      if (handlers.size === 0) { this.subscribers.delete(channel); }
    };
  }
  publish(channel, message) {
    this.deliverLocally(channel, message);
    const env = { kind: 'pub', channel, body: message };
    this.sendToAll(env);
  }
  ready() {
    return this.readyPromise;
  }
}
`;

    // Build publisher script
    const publisherCode = `
${minimalIpcBusJS}

(async () => {
  const bus = new IpcBus('${sock}');
  await bus.ready();
  // Small delay to ensure socket connection is fully established
  await new Promise(r => setTimeout(r, 50));
  // Publish a few times to avoid startup-race drops during cross-process handshake.
  for (let i = 0; i < 5; i++) {
    bus.publish('task.delta', { type: 'sentinel', data: 'world' });
    await new Promise(r => setTimeout(r, 30));
  }
  process.send({ published: true });
})().catch((e) => {
  process.send({ error: e.message });
  process.exit(1);
});
`;

    // Build subscriber script
    const subscriberCode = `
${minimalIpcBusJS}

(async () => {
  const bus = new IpcBus('${sock}');
  await bus.ready();
  // Small delay to ensure socket connection is fully established
  await new Promise(r => setTimeout(r, 50));
  bus.subscribe('task.delta', (msg) => {
    if (msg && msg.type === 'sentinel') {
      process.send({ received: true });
    }
  });
  process.send({ ready: true });
})().catch((e) => {
  process.send({ error: e.message });
  process.exit(1);
});
`;

    // Spawn subscriber first
    const procB = spawn('node', ['-e', subscriberCode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    // Collect messages and stderr from subscriber
    const messages: { a: any[]; b: any[] } = { a: [], b: [] };
    let stderrA = '';
    let stderrB = '';
    let resolveTest: () => void;
    const testPromise = new Promise<void>((r) => { resolveTest = r; });

    procB.stderr?.on('data', (chunk) => { stderrB += chunk.toString(); });

    procB.on('message', (msg: any) => {
      messages.b.push(msg);
      if (msg.received) {
        resolveTest();
      }
    });

    // Wait for subscriber to be ready before starting publisher
    try {
      await waitFor(() => messages.b.some((m: any) => m.ready), 2000);
    } catch (e) {
      console.error('Process B stderr:', stderrB);
      throw e;
    }

    // Now spawn publisher after subscriber is ready
    const procA = spawn('node', ['-e', publisherCode], {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });

    procA.stderr?.on('data', (chunk) => { stderrA += chunk.toString(); });

    procA.on('message', (msg: any) => {
      messages.a.push(msg);
    });

    // Wait for the sentinel message to be received
    await Promise.race([
      testPromise,
      sleep(3000).then(() => {
        console.error('Process A stderr:', stderrA);
        console.error('Process B stderr:', stderrB);
        throw new Error('Test timed out waiting for cross-process message (reversed)');
      }),
    ]);

    // Clean up
    procA.kill();
    procB.kill();

    expect(messages.b.some((m: any) => m.received)).toBe(true);
    expect(messages.a.some((m: any) => m.error)).toBe(false);
  }, 10000);
});

// ---------------------------------------------------------------------------
// Malformed-frame observability
// ---------------------------------------------------------------------------

describe('Malformed-frame observability', () => {
  const buses: IpcBus[] = [];

  afterEach(() => {
    for (const bus of buses) {
      bus.disconnect();
    }
    buses.length = 0;
  });

  /** Encode a raw length-prefixed frame from an arbitrary string payload. */
  function encodeRaw(payload: string): Buffer {
    const json = Buffer.from(payload, 'utf8');
    const frame = Buffer.allocUnsafe(4 + json.length);
    frame.writeUInt32BE(json.length, 0);
    json.copy(frame, 4);
    return frame;
  }

  /** Connect a raw socket to the given path and wait for it to be ready. */
  function rawConnect(socketPath: string): Promise<import('node:net').Socket> {
    return new Promise((resolve, reject) => {
      const sock = createConnection({ path: socketPath }, () => resolve(sock));
      sock.on('error', reject);
    });
  }

  it('fires onMalformedFrame for invalid JSON', async () => {
    const sock = tempSocketPath();
    const events: MalformedFrameEvent[] = [];
    const bus = new IpcBus(sock, { onMalformedFrame: (e) => events.push(e) });
    buses.push(bus);
    await bus.ready();

    // Send a frame whose payload is not valid JSON.
    const raw = rawConnect(sock);
    const peer = await raw;
    peer.write(encodeRaw('not-json{{{'));

    await waitFor(() => events.length >= 1, 2000);
    peer.destroy();

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('invalid_json');
    expect(events[0].rawByteLength).toBe(Buffer.byteLength('not-json{{{', 'utf8'));
    expect(events[0].droppedSinceLastReport).toBe(0);
    expect(events[0].timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('fires onMalformedFrame for valid JSON with invalid envelope shape', async () => {
    const sock = tempSocketPath();
    const events: MalformedFrameEvent[] = [];
    const bus = new IpcBus(sock, { onMalformedFrame: (e) => events.push(e) });
    buses.push(bus);
    await bus.ready();

    // Valid JSON but missing required envelope fields.
    const raw = rawConnect(sock);
    const peer = await raw;
    peer.write(encodeRaw('{"kind":"pub"}'));

    await waitFor(() => events.length >= 1, 2000);
    peer.destroy();

    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('invalid_envelope');
  });

  it('rate-limits malformed frame events', async () => {
    const sock = tempSocketPath();
    const events: MalformedFrameEvent[] = [];
    // Use rateLimitMs=0 would disable limiting; we rely on default.
    const bus = new IpcBus(sock, { onMalformedFrame: (e) => events.push(e) });
    buses.push(bus);
    await bus.ready();

    const peer = await rawConnect(sock);

    // Send many malformed frames rapidly — default rate limit is 1 s,
    // so only the first should be emitted immediately.
    for (let i = 0; i < 10; i++) {
      peer.write(encodeRaw(`bad-json-${i}`));
    }

    // Wait for socket data to be processed.
    await sleep(200);
    peer.destroy();

    // Exactly 1 event emitted due to rate limiting (the other 9 suppressed).
    expect(events).toHaveLength(1);
    expect(events[0].droppedSinceLastReport).toBe(0);
  });

  it('reports suppressed count after rate-limit window elapses', async () => {
    const sock = tempSocketPath();
    const events: MalformedFrameEvent[] = [];
    const bus = new IpcBus(sock, { onMalformedFrame: (e) => events.push(e) });
    buses.push(bus);
    await bus.ready();

    const peer = await rawConnect(sock);

    // First burst — first frame emitted, rest suppressed.
    for (let i = 0; i < 5; i++) {
      peer.write(encodeRaw(`bad-${i}`));
    }
    await sleep(200);
    expect(events).toHaveLength(1);

    // Wait for rate-limit window to pass.
    await sleep(MALFORMED_FRAME_RATE_LIMIT_MS + 100);

    // Second malformed frame triggers a new event with suppressed count.
    peer.write(encodeRaw('another-bad'));
    await waitFor(() => events.length >= 2, 2000);
    peer.destroy();

    expect(events).toHaveLength(2);
    // 4 frames were suppressed between the first and second emitted events.
    expect(events[1].droppedSinceLastReport).toBe(4);
  });

  it('does not fire callback when no observer is provided', async () => {
    const sock = tempSocketPath();
    // No onMalformedFrame — should not throw.
    const bus = new IpcBus(sock);
    buses.push(bus);
    await bus.ready();

    const peer = await rawConnect(sock);
    peer.write(encodeRaw('not-json'));
    await sleep(200);
    peer.destroy();

    // If we get here without an unhandled exception, the test passes.
    expect(true).toBe(true);
  });

  it('still delivers valid frames alongside malformed ones', async () => {
    const sock = tempSocketPath();
    const events: MalformedFrameEvent[] = [];
    const bus = new IpcBus(sock, { onMalformedFrame: (e) => events.push(e) });
    buses.push(bus);
    await bus.ready();

    const received: string[] = [];
    bus.subscribe('test', (msg: string) => received.push(msg));

    const peer = await rawConnect(sock);
    // Send a malformed frame followed by a valid pub envelope.
    const malformed = encodeRaw('garbage');
    const valid = encodeRaw(JSON.stringify({ kind: 'pub', channel: 'test', body: 'hello' }));
    peer.write(Buffer.concat([malformed, valid]));

    await waitFor(() => received.length >= 1, 2000);
    peer.destroy();

    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(received).toEqual(['hello']);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Spin-wait (event-loop-friendly) until predicate is true or timeout. */
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    }
    await sleep(10);
  }
}

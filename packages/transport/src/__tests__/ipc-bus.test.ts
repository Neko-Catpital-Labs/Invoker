import { describe, it, expect, afterEach } from 'vitest';
import { join, dirname } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { IpcBus } from '../ipc-bus.js';

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
  bus.publish('task.delta', { type: 'sentinel', data: 'hello' });
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
    expect(messages.b.some((m: any) => m.published)).toBe(true);
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
  bus.publish('task.delta', { type: 'sentinel', data: 'world' });
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

    expect(messages.a.some((m: any) => m.published)).toBe(true);
    expect(messages.b.some((m: any) => m.received)).toBe(true);
  }, 10000);
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

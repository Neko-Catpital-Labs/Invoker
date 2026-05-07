import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { TransportError, TransportErrorCode } from '../transport-error.js';
import { LocalBus } from '../local-bus.js';
import { IpcBus } from '../ipc-bus.js';

function tempSocketPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'transport-error-test-'));
  return join(dir, 'test.sock');
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

describe('TransportError', () => {
  it('is an instance of Error', () => {
    const err = new TransportError(TransportErrorCode.NO_HANDLER, 'test');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(TransportError);
  });

  it('carries the code and message fields', () => {
    const err = new TransportError(TransportErrorCode.DISCONNECTED, 'bus gone');
    expect(err.code).toBe('DISCONNECTED');
    expect(err.message).toBe('bus gone');
    expect(err.name).toBe('TransportError');
  });

  it('exposes all expected error codes', () => {
    expect(TransportErrorCode.NO_HANDLER).toBe('NO_HANDLER');
    expect(TransportErrorCode.DISCONNECTED).toBe('DISCONNECTED');
    expect(TransportErrorCode.HANDLER_ERROR).toBe('HANDLER_ERROR');
  });
});

describe('LocalBus typed error codes', () => {
  let bus: LocalBus;

  beforeEach(() => {
    bus = new LocalBus();
  });

  it('throws TransportError with NO_HANDLER when no handler registered', async () => {
    try {
      await bus.request('missing-channel', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.NO_HANDLER);
      expect((err as TransportError).message).toContain('missing-channel');
    }
  });
});

describe('IpcBus typed error codes', () => {
  const buses: IpcBus[] = [];

  function createBus(socketPath: string, opts?: { allowServe?: boolean }): IpcBus {
    const bus = new IpcBus(socketPath, opts);
    buses.push(bus);
    return bus;
  }

  afterEach(() => {
    for (const bus of buses) {
      bus.disconnect();
    }
    buses.length = 0;
  });

  it('rejects with TransportError NO_HANDLER for unhandled cross-instance request', async () => {
    const sock = tempSocketPath();
    const server = createBus(sock);
    await server.ready();

    const client = createBus(sock);
    await client.ready();
    await sleep(50);

    try {
      await client.request('no-such-channel', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.NO_HANDLER);
    }
  });

  it('rejects with TransportError HANDLER_ERROR when handler throws', async () => {
    const sock = tempSocketPath();
    const server = createBus(sock);
    await server.ready();

    server.onRequest('failing', () => {
      throw new Error('handler boom');
    });

    const client = createBus(sock);
    await client.ready();
    await sleep(50);

    try {
      await client.request('failing', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.HANDLER_ERROR);
      expect((err as TransportError).message).toBe('handler boom');
    }
  });

  it('rejects with TransportError DISCONNECTED on disconnect', async () => {
    const sock = tempSocketPath();
    const server = createBus(sock);
    await server.ready();

    // Register a handler that never resolves, keeping the request pending
    server.onRequest('slow-channel', () => new Promise(() => {}));

    const client = createBus(sock);
    await client.ready();
    await sleep(50);

    // Start a request that will pend forever, then disconnect the client
    const requestPromise = client.request('slow-channel', {});
    // Allow the request envelope to reach the server
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

  it('preserves TransportError code through handler that throws TransportError', async () => {
    const sock = tempSocketPath();
    const server = createBus(sock);
    await server.ready();

    server.onRequest('custom-error', () => {
      throw new TransportError(TransportErrorCode.NO_HANDLER, 'custom no handler');
    });

    const client = createBus(sock);
    await client.ready();
    await sleep(50);

    try {
      await client.request('custom-error', {});
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).code).toBe(TransportErrorCode.NO_HANDLER);
      expect((err as TransportError).message).toBe('custom no handler');
    }
  });
});

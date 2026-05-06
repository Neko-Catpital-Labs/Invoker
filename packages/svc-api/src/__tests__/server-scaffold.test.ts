import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createApiServer, startServer } from '../server.js';

/** Send a GET request to a running server and return { statusCode, body }. */
function httpGet(server: Server, path = '/health'): Promise<{ statusCode: number; body: string }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server not listening on a TCP address');
  }

  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: addr.port, method: 'GET', path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Close a server, ignoring errors if already closed. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe('createApiServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('returns an http.Server instance', () => {
    server = createApiServer();
    expect(server).toBeDefined();
    expect(typeof server.listen).toBe('function');
    expect(typeof server.close).toBe('function');
  });

  it('uses the default handler that returns { status: "ok" }', async () => {
    server = createApiServer();

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });

    const { statusCode, body } = await httpGet(server);
    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
  });

  it('accepts a custom handler', async () => {
    server = createApiServer((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'text/plain' });
      res.end('custom');
    });

    await new Promise<void>((resolve) => {
      server!.listen(0, '127.0.0.1', () => resolve());
    });

    const { statusCode, body } = await httpGet(server);
    expect(statusCode).toBe(201);
    expect(body).toBe('custom');
  });
});

describe('startServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('resolves with a listening server on the requested port', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const addr = server.address();

    expect(addr).not.toBeNull();
    expect(typeof addr).toBe('object');
    if (typeof addr === 'object' && addr) {
      expect(addr.port).toBeGreaterThan(0);
    }
  });

  it('serves responses through the default handler after start', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' });
    const { statusCode, body } = await httpGet(server);

    expect(statusCode).toBe(200);
    expect(JSON.parse(body)).toEqual({ status: 'ok' });
  });

  it('serves responses through a custom handler when provided', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1' }, (_req, res) => {
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ tea: 'pot' }));
    });

    const { statusCode, body } = await httpGet(server);
    expect(statusCode).toBe(418);
    expect(JSON.parse(body)).toEqual({ tea: 'pot' });
  });

  it('defaults host to 0.0.0.0 when omitted', async () => {
    server = await startServer({ port: 0 });
    const addr = server.address();

    expect(addr).not.toBeNull();
    if (typeof addr === 'object' && addr) {
      expect(addr.address).toBe('0.0.0.0');
    }
  });
});

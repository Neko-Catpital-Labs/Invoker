import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { request } from 'node:http';
import { createApiServer } from '../server.js';

/** Send an HTTP request to a running server and return { statusCode, headers, body }. */
function httpRequest(
  server: Server,
  path: string,
  method = 'GET',
): Promise<{ statusCode: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  const addr = server.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server not listening on a TCP address');
  }

  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: '127.0.0.1', port: addr.port, method, path },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('endpoint contracts', () => {
  let server: Server;

  beforeAll(async () => {
    server = createApiServer();
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve());
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe('GET /health', () => {
    it('returns 200 with { status: "ok" }', async () => {
      const { statusCode, headers, body } = await httpRequest(server, '/health');

      expect(statusCode).toBe(200);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ status: 'ok' });
    });
  });

  describe('GET /hello', () => {
    it('returns 200 with { message: "hello" }', async () => {
      const { statusCode, headers, body } = await httpRequest(server, '/hello');

      expect(statusCode).toBe(200);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ message: 'hello' });
    });
  });

  describe('method not allowed', () => {
    it('returns 405 for POST /health', async () => {
      const { statusCode, headers, body } = await httpRequest(server, '/health', 'POST');

      expect(statusCode).toBe(405);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ error: 'Method Not Allowed' });
    });

    it('returns 405 for POST /hello', async () => {
      const { statusCode, headers, body } = await httpRequest(server, '/hello', 'POST');

      expect(statusCode).toBe(405);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ error: 'Method Not Allowed' });
    });
  });

  describe('unknown path', () => {
    it('returns 404 for GET /unknown', async () => {
      const { statusCode, headers, body } = await httpRequest(server, '/unknown');

      expect(statusCode).toBe(404);
      expect(headers['content-type']).toBe('application/json');
      expect(JSON.parse(body)).toEqual({ error: 'Not Found' });
    });
  });
});

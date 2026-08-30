/**
 * Repro: GET/HEAD /invoke serves SPA HTML
 *
 * Symptom: POST /invoke is RPC. PUT/OPTIONS correctly 405. Cookie GET /invoke
 * returns 200 text/html SPA. Header-only GET returns 401 (static cookie check),
 * not 405.
 *
 * Root cause: GET/HEAD requests to /invoke are not explicitly rejected as 405.
 * They fall through to the static file handler which serves the SPA HTML.
 *
 * Invariant: /invoke is POST-only; other methods should return 405 before
 * any static fallback.
 *
 * Fix applied:
 * - /invoke path now checks method first
 * - Non-POST requests to /invoke return 405 method_not_allowed
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { startWebBridge, type WebBridge } from '../web/web-bridge-server.js';

describe('/invoke method validation', () => {
  let bridge: WebBridge;
  let port: number;
  let token: string;
  let tmpDir: string;

  beforeAll(async () => {
    token = 'test-token-' + Math.random().toString(36).slice(2);
    tmpDir = mkdtempSync(join(tmpdir(), 'web-bridge-test-'));
    mkdirSync(join(tmpDir, 'dist'));
    writeFileSync(join(tmpDir, 'dist', 'index.html'), '<!DOCTYPE html><html><body>Test</body></html>');

    const bus = new LocalBus();
    bridge = startWebBridge({
      token,
      dispatch: async () => ({ ok: true }),
      messageBus: bus,
      persistence: {
        getActivityLogs: () => [],
        listWorkflows: () => [],
      },
      uiDistDir: join(tmpDir, 'dist'),
      host: '127.0.0.1',
      port: 0,
    });
    port = await bridge.whenReady;
  });

  afterAll(async () => {
    await bridge?.close();
  });

  function makeRequest(method: string, path: string, cookie?: string): Promise<{ status: number; contentType: string; body: string }> {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method,
        path,
        headers: cookie ? { cookie } : {},
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            contentType: res.headers['content-type'] ?? '',
            body,
          });
        });
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('POST /invoke without auth returns 401', async () => {
    const res = await makeRequest('POST', '/invoke');
    expect(res.status).toBe(401);
  });

  it('PUT /invoke returns 405 method not allowed', async () => {
    const res = await makeRequest('PUT', '/invoke');
    expect(res.status).toBe(405);
  });

  it('OPTIONS /invoke returns 405 method not allowed', async () => {
    const res = await makeRequest('OPTIONS', '/invoke');
    expect(res.status).toBe(405);
  });

  it('GET /invoke without auth returns 405', async () => {
    const res = await makeRequest('GET', '/invoke');
    expect(res.status).toBe(405);
  });

  it('GET /invoke with auth returns 405', async () => {
    const cookie = `invoker_web_token=${token}`;
    const res = await makeRequest('GET', '/invoke', cookie);
    expect(res.status).toBe(405);
    expect(res.contentType).not.toContain('text/html');
  });

  it('HEAD /invoke with auth returns 405', async () => {
    const cookie = `invoker_web_token=${token}`;
    const res = await makeRequest('HEAD', '/invoke', cookie);
    expect(res.status).toBe(405);
  });
});

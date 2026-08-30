/**
 * Repro: 413 then keep-alive ECONNRESET
 *
 * Symptom: POST /invoke body > 1 MiB returns 413 correctly, then req.destroy()
 * drops the socket. Next request on the same HTTP keep-alive agent:
 * "write ECONNRESET" / Connection reset by peer.
 *
 * TODO(chaos-b-fix): These tests are marked it.fails because the current
 * implementation uses req.destroy() after a 413 response, which severs the
 * TCP connection immediately and causes ECONNRESET on subsequent requests.
 *
 * After the fix applies:
 * - sendJson will send Connection: close header for 413 responses
 * - req.resume() will drain the body instead of req.destroy() dropping the socket
 * - These tests will pass and should be changed from it.fails to it
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { request as httpRequest, Agent } from 'node:http';
import type { MessageBus } from '@invoker/transport';
import { startWebBridge, type WebBridge, type WebBridgeDeps } from '../web/web-bridge-server.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function makeMinimalDeps(uiDistDir: string): WebBridgeDeps {
  const mockMessageBus: Pick<MessageBus, 'subscribe'> = {
    subscribe: () => () => {},
  };

  const mockPersistence = {
    getActivityLogs: () => [],
    listWorkflows: () => [],
  };

  return {
    dispatch: async () => ({ ok: true }),
    messageBus: mockMessageBus,
    persistence: mockPersistence as any,
    uiDistDir,
    token: 'test-token',
    host: '127.0.0.1',
    port: 0,
  };
}

function createMinimalUiDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'web-bridge-413-test-'));
  writeFileSync(join(dir, 'web.html'), '<html><body>Test</body></html>');
  return dir;
}

function httpPost(options: {
  hostname: string;
  port: number;
  path: string;
  body: string;
  headers?: Record<string, string>;
  agent?: Agent;
}): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: options.hostname,
        port: options.port,
        path: options.path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...options.headers,
        },
        agent: options.agent,
      },
      (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => resolve({ statusCode: res.statusCode ?? 0, body }));
      }
    );
    req.on('error', reject);
    req.write(options.body);
    req.end();
  });
}

describe('web-bridge 413 keep-alive handling', () => {
  let uiDistDir: string;
  let bridge: WebBridge;

  beforeEach(async () => {
    uiDistDir = createMinimalUiDist();
  });

  afterEach(async () => {
    await bridge?.close();
    rmSync(uiDistDir, { recursive: true, force: true });
  });

  it.fails('413 response does not poison keep-alive connection', async () => {
    const deps = makeMinimalDeps(uiDistDir);
    bridge = startWebBridge(deps);
    const port = await bridge.whenReady;

    const agent = new Agent({ keepAlive: true, maxSockets: 1 });

    try {
      const oversizeBody = JSON.stringify({
        channel: 'invoker:test',
        args: [{ data: 'x'.repeat(2 * 1024 * 1024) }],
      });

      const res1 = await httpPost({
        hostname: '127.0.0.1',
        port,
        path: '/invoke',
        body: oversizeBody,
        headers: { 'x-invoker-token': 'test-token' },
        agent,
      });

      expect(res1.statusCode).toBe(413);

      const smallBody = JSON.stringify({
        channel: 'invoker:get-status',
        args: [],
      });

      const res2 = await httpPost({
        hostname: '127.0.0.1',
        port,
        path: '/invoke',
        body: smallBody,
        headers: { 'x-invoker-token': 'test-token' },
        agent,
      });

      expect(res2.statusCode).toBe(200);
    } finally {
      agent.destroy();
    }
  });

  it.fails('413 response includes Connection: close header', async () => {
    const deps = makeMinimalDeps(uiDistDir);
    bridge = startWebBridge(deps);
    const port = await bridge.whenReady;

    const oversizeBody = JSON.stringify({
      channel: 'invoker:test',
      args: [{ data: 'x'.repeat(2 * 1024 * 1024) }],
    });

    const responseHeaders = await new Promise<Record<string, string | string[] | undefined>>((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          path: '/invoke',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-invoker-token': 'test-token',
          },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.headers));
        }
      );
      req.on('error', reject);
      req.write(oversizeBody);
      req.end();
    });

    expect(responseHeaders.connection?.toString().toLowerCase()).toBe('close');
  });
});

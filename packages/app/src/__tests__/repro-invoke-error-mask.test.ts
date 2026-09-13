/**
 * Repro: Web /invoke masks thrown errors as "internal server error"
 *
 * Symptom: HTTP 200 `{ok:false,error:{message:"internal server error"}}` for
 * validation/domain errors like get-events missing options, limit 0/101,
 * approve/delete-task/edit-task-command on merge, set-workflow-merge-mode
 * with invalid mode.
 *
 * Root cause: Uncaught exceptions without a `.code` property are caught and
 * masked as "internal server error" to avoid leaking stack traces.
 *
 * Invariant: Validation/domain errors must surface code+message, not a
 * generic mask. Known error types should map to specific codes.
 *
 * Fix applied:
 * - Known error patterns are mapped to specific error codes
 * - Validation, not-found, and invalid-operation errors are surfaced
 * - Unknown errors are still masked to avoid leaking stack traces
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { LocalBus } from '@invoker/transport';
import { startWebBridge, type WebBridge } from '../web/web-bridge-server.js';

describe('/invoke error handling', () => {
  let bridge: WebBridge;
  let port: number;
  let token: string;
  let tmpDir: string;

  beforeAll(async () => {
    token = 'test-token-' + Math.random().toString(36).slice(2);
    tmpDir = mkdtempSync(join(tmpdir(), 'web-bridge-error-test-'));
    mkdirSync(join(tmpDir, 'dist'));
    writeFileSync(join(tmpDir, 'dist', 'index.html'), '<!DOCTYPE html><html><body>Test</body></html>');

    const bus = new LocalBus();
    bridge = startWebBridge({
      token,
      dispatch: async (channel, args) => {
        if (channel === 'test:validation-error') {
          throw new Error('Validation failed: limit must be between 1 and 100');
        }
        if (channel === 'test:not-found') {
          throw new Error('Task not found: wf-123/task-456');
        }
        if (channel === 'test:invalid-operation') {
          throw new Error('Cannot approve merge node directly');
        }
        if (channel === 'test:domain-error-with-code') {
          const err = new Error('Task not found') as Error & { code: string };
          err.code = 'TASK_NOT_FOUND';
          throw err;
        }
        return { ok: true };
      },
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

  function invoke(channel: string, args: unknown[] = []): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ channel, args });
      const req = http.request({
        hostname: '127.0.0.1',
        port,
        method: 'POST',
        path: '/invoke',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          'x-invoker-token': token,
        },
      }, (res) => {
        let body = '';
        res.on('data', (chunk) => { body += chunk; });
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body });
          }
        });
      });
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  it('returns error code when error has .code property', async () => {
    const res = await invoke('test:domain-error-with-code');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.code).toBe('TASK_NOT_FOUND');
  });

  it('should surface validation error message with code', async () => {
    const res = await invoke('test:validation-error');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).not.toBe('internal server error');
    expect(res.body.error.message).toContain('Validation failed');
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('should surface not-found error message with code', async () => {
    const res = await invoke('test:not-found');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).not.toBe('internal server error');
    expect(res.body.error.message).toContain('not found');
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('should surface invalid operation error message with code', async () => {
    const res = await invoke('test:invalid-operation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error.message).not.toBe('internal server error');
    expect(res.body.error.message).toContain('Cannot approve');
    expect(res.body.error.code).toBe('INVALID_OPERATION');
  });
});

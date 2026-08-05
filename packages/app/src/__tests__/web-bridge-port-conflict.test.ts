import { describe, expect, it } from 'vitest';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { startWebBridge, type WebBridge } from '../web/web-bridge-server.js';

// Regression fence for the production crashes
//   uncaughtException: Error: listen EADDRINUSE: address already in use 0.0.0.0:4200
// (invoker.log 2026-07-30 02:05/04:46, 2026-08-03 19:33/23:18/23:19): the web
// bridge had no server 'error' listener, so losing the bind race killed the
// whole booting process. Also fences the refuted storm hypothesis: request
// bursts never harmed the listener.

const TOKEN = 'repro-token';

function stubDeps() {
  return {
    dispatch: (async () => ({})) as never,
    messageBus: {
      subscribe: () => () => {},
      publish: () => {},
    } as never,
    persistence: { getActivityLogs: () => [], listWorkflows: () => [] } as never,
    uiDistDir: tmpdir(),
    token: TOKEN,
    host: '127.0.0.1',
  };
}

function fire(port: number, path: string, opts: { headers?: Record<string, string>; abortAfterMs?: number } = {}): Promise<number | 'aborted' | 'error'> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers: opts.headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
      res.on('error', () => resolve('error'));
      if (opts.abortAfterMs !== undefined) {
        setTimeout(() => { req.destroy(); resolve('aborted'); }, opts.abortAfterMs);
      }
    });
    req.on('error', () => resolve(opts.abortAfterMs !== undefined ? 'aborted' : 'error'));
    req.end();
  });
}

describe('web bridge port conflict', () => {
  it('survives a 600-request connection storm', async () => {
    const bridge: WebBridge = startWebBridge({ ...stubDeps(), port: 0 });
    const port = await bridge.whenReady;
    try {
      const storm: Promise<unknown>[] = [];
      for (let i = 0; i < 200; i++) storm.push(fire(port, '/invoke', { headers: { 'x-invoker-token': 'wrong' } }));
      for (let i = 0; i < 200; i++) storm.push(fire(port, `/events?token=${TOKEN}`, { abortAfterMs: 25 }));
      for (let i = 0; i < 200; i++) storm.push(fire(port, '/', {}));
      await Promise.all(storm);

      const after = await fire(port, '/', {});
      expect(typeof after).toBe('number');
    } finally {
      await bridge.close();
    }
  }, 30_000);

  it('losing the bind race settles whenReady with EADDRINUSE instead of escalating to a process-level uncaughtException', async () => {
    const first: WebBridge = startWebBridge({ ...stubDeps(), port: 0 });
    const port = await first.whenReady;

    const priorListeners = process.listeners('uncaughtException');
    process.removeAllListeners('uncaughtException');
    let escalated: Error | null = null;
    const trap = (err: Error) => { escalated = err; };
    process.on('uncaughtException', trap);
    let second: WebBridge | null = null;
    try {
      second = startWebBridge({ ...stubDeps(), port });

      const outcome = await Promise.race([
        second.whenReady.then(
          () => ({ kind: 'resolved' as const }),
          (err: NodeJS.ErrnoException) => ({ kind: 'settled-with-failure' as const, code: err.code }),
        ),
        new Promise<{ kind: 'dangling' }>((r) => setTimeout(() => r({ kind: 'dangling' }), 5_000)),
      ]);

      expect(outcome).toEqual({ kind: 'settled-with-failure', code: 'EADDRINUSE' });
      expect(escalated, 'a lost bind race must never reach the process-level uncaughtException handler').toBeNull();

      const stillServing = await fire(port, '/', {});
      expect(typeof stillServing, 'the winning listener must be unaffected').toBe('number');

      await expect(second.close()).resolves.toBeUndefined();
      second = null;
    } finally {
      process.removeListener('uncaughtException', trap);
      for (const l of priorListeners) process.on('uncaughtException', l);
      await first.close();
      await second?.close().catch(() => {});
    }
  }, 20_000);
});

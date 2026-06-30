import { afterEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import { gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { startWebBridge, type WebBridge } from '../web/web-bridge-server.js';

const TOKEN = 'secret-token';

function makeBus() {
  const subs = new Map<string, Set<(payload: unknown) => void>>();
  return {
    subscribe(channel: string, cb: (payload: unknown) => void) {
      let set = subs.get(channel);
      if (!set) {
        set = new Set();
        subs.set(channel, set);
      }
      set.add(cb);
      return () => set!.delete(cb);
    },
    publish(channel: string, payload: unknown) {
      for (const cb of subs.get(channel) ?? []) cb(payload);
    },
  };
}

interface RequestResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawBody: Buffer;
}

function request(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RequestResult> {
  const { promise, resolve, reject } = Promise.withResolvers<RequestResult>();
  const req = http.request(
    { host: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: options.headers },
    (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c as Buffer));
      res.on('end', () => {
        const rawBody = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: rawBody.toString('utf8'), rawBody });
      });
    },
  );
  req.on('error', reject);
  if (options.body) req.write(options.body);
  req.end();
  return promise;
}

let bridge: WebBridge | null = null;

async function startBridge(dispatch = vi.fn(async () => ({ ok: true }))) {
  const bus = makeBus();
  bridge = startWebBridge({
    dispatch: dispatch as never,
    messageBus: bus as never,
    persistence: { getActivityLogs: () => [], listWorkflows: () => [] } as never,
    uiDistDir: tmpdir(),
    token: TOKEN,
    host: '127.0.0.1',
    port: 0,
  });
  const port = await bridge.whenReady;
  return { port, bus, dispatch };
}

afterEach(async () => {
  await bridge?.close();
  bridge = null;
});

describe('startWebBridge', () => {
  it('rejects /invoke without a cookie or token header', async () => {
    const { port } = await startBridge();
    const res = await request(port, '/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ channel: 'invoker:get-status', args: [] }),
    });
    expect(res.status).toBe(401);
  });

  it('exchanges ?token for a Set-Cookie and redirects to /', async () => {
    const { port } = await startBridge();
    const res = await request(port, `/?token=${TOKEN}`);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
    expect(String(res.headers['set-cookie'])).toContain('invoker_web=');
  });

  it('rejects the handshake with a bad token', async () => {
    const { port } = await startBridge();
    const res = await request(port, '/?token=wrong');
    expect(res.status).toBe(401);
  });

  it('runs /invoke with a valid cookie and wraps the dispatch result', async () => {
    const dispatch = vi.fn(async () => ({ value: 42 }));
    const { port } = await startBridge(dispatch);
    const res = await request(port, '/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `invoker_web=${TOKEN}` },
      body: JSON.stringify({ channel: 'invoker:get-status', args: [] }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true, result: { value: 42 } });
    expect(dispatch).toHaveBeenCalledWith('invoker:get-status', []);
  });

  it('compresses large /invoke JSON responses when the browser accepts gzip', async () => {
    const dispatch = vi.fn(async () => ({ value: 'x'.repeat(8_000) }));
    const { port } = await startBridge(dispatch);
    const res = await request(port, '/invoke', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: `invoker_web=${TOKEN}`,
        'accept-encoding': 'gzip',
      },
      body: JSON.stringify({ channel: 'invoker:get-action-graph', args: [] }),
    });

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(JSON.parse(gunzipSync(res.rawBody).toString('utf8'))).toEqual({
      ok: true,
      result: { value: 'x'.repeat(8_000) },
    });
  });

  it('reports dispatch failures as { ok: false, error }', async () => {
    const dispatch = vi.fn(async () => {
      const err = new Error('nope') as Error & { code: string };
      err.code = 'unknown_channel';
      throw err;
    });
    const { port } = await startBridge(dispatch);
    const res = await request(port, '/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `invoker_web=${TOKEN}` },
      body: JSON.stringify({ channel: 'invoker:x', args: [] }),
    });
    expect(JSON.parse(res.body)).toEqual({ ok: false, error: { message: 'request failed', code: 'unknown_channel' } });
  });

  it('hides unexpected dispatch failure details from web responses', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('stack trace shaped internal failure');
    });
    const { port } = await startBridge(dispatch);
    const res = await request(port, '/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `invoker_web=${TOKEN}` },
      body: JSON.stringify({ channel: 'invoker:get-status', args: [] }),
    });

    expect(JSON.parse(res.body)).toEqual({ ok: false, error: { message: 'internal server error' } });
  });

  it('streams broadcast and TASK_OUTPUT events over /events', async () => {
    const { port, bus } = await startBridge();
    const { promise, resolve, reject } = Promise.withResolvers<string>();
    const req = http.request(
      { host: '127.0.0.1', port, path: '/events', headers: { cookie: `invoker_web=${TOKEN}` } },
      (res) => {
        expect(res.statusCode).toBe(200);
        let buffer = '';
        res.on('data', (c) => {
          buffer += (c as Buffer).toString('utf8');
          if (buffer.includes('event: invoker:task-output')) {
            req.destroy();
            resolve(buffer);
          }
        });
      },
    );
    req.on('error', () => { /* destroyed after resolve */ });
    req.end();
    // Give the SSE connection a tick to register, then publish a task.output.
    await new Promise((r) => setTimeout(r, 50));
    bridge!.broadcast('invoker:task-graph-event', { type: 'snapshot' });
    bus.publish('task.output', { taskId: 'wf-1/task-1', chunk: 'hello' });
    const received = await Promise.race([
      promise,
      new Promise<string>((_, rej) => setTimeout(() => rej(new Error('SSE timeout')), 2000)),
    ]);
    expect(received).toContain('event: invoker:task-graph-event');
    expect(received).toContain('event: invoker:task-output');
    expect(received).toContain('"taskId":"wf-1/task-1"');
  });
});

describe('startWebBridge static serving', () => {
  function makeDist(): string {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-web-dist-'));
    writeFileSync(join(dir, 'web.html'), '<!doctype html><div id="root">SHELL</div>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'web-abc.js'), 'console.log("app");');
    return dir;
  }

  async function startStaticBridge() {
    const bus = makeBus();
    bridge = startWebBridge({
      dispatch: (async () => ({})) as never,
      messageBus: bus as never,
      persistence: { getActivityLogs: () => [], listWorkflows: () => [] } as never,
      uiDistDir: makeDist(),
      token: TOKEN,
      host: '127.0.0.1',
      port: 0,
    });
    return await bridge.whenReady;
  }

  it('requires the cookie for the page and assets', async () => {
    const port = await startStaticBridge();
    expect((await request(port, '/')).status).toBe(401);
    expect((await request(port, '/assets/web-abc.js')).status).toBe(401);
  });

  it('serves the shell and assets with the right content types once authed', async () => {
    const port = await startStaticBridge();
    const cookie = `invoker_web=${TOKEN}`;
    const shell = await request(port, '/', { headers: { cookie } });
    expect(shell.status).toBe(200);
    expect(shell.headers['content-type']).toContain('text/html');
    expect(shell.body).toContain('SHELL');
    const asset = await request(port, '/assets/web-abc.js', { headers: { cookie } });
    expect(asset.status).toBe(200);
    expect(asset.headers['content-type']).toContain('javascript');
    // Unknown non-asset route falls back to the SPA shell.
    const spa = await request(port, '/workflow/wf-1', { headers: { cookie } });
    expect(spa.status).toBe(200);
    expect(spa.body).toContain('SHELL');
  });
});

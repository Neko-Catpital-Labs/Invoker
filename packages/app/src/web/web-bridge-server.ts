/**
 * Web bridge HTTP server.
 *
 * Serves the built Electron React UI over HTTP and exposes the same
 * `InvokerAPI` the renderer uses, via two transports the web shim
 * (packages/ui/src/web/web-invoker-client.ts) speaks:
 *   - `POST /invoke`  request/response → `deps.dispatch(channel, args)`
 *   - `GET  /events`  Server-Sent Events push (task graph, output, activity)
 *
 * Auth is a single shared secret (no user accounts). `GET /?token=<t>` sets an
 * HttpOnly cookie and redirects to `/` (dropping the token from the URL).
 * Page + asset requests require the cookie; `/invoke` and `/events` accept the
 * cookie OR an `x-invoker-token` header (for non-browser clients). Same-origin
 * only — no CORS headers are emitted.
 *
 * Plain `node:http` + `node:fs` — no new runtime dependency.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, normalize, sep, extname } from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '@invoker/contracts';
import { Channels, type MessageBus } from '@invoker/transport';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { WebInvokerDispatch } from './web-invoker-dispatch.js';

const COOKIE_NAME = 'invoker_web';
const MAX_INVOKE_BODY_BYTES = 1024 * 1024; // 1 MiB
const MAX_SSE_CLIENTS = 64;
const SSE_PING_INTERVAL_MS = 20_000;
const ACTIVITY_POLL_INTERVAL_MS = 2_000;
const WORKFLOWS_POLL_INTERVAL_MS = 2_000;
const SSE_DROP_BUFFER_BYTES = 8 * 1024 * 1024; // drop a client whose backlog exceeds this
const JSON_COMPRESSION_MIN_BYTES = 1024;

export interface WebBridgeDeps {
  logger?: Logger;
  dispatch: WebInvokerDispatch;
  messageBus: Pick<MessageBus, 'subscribe'>;
  persistence: Pick<SQLiteAdapter, 'getActivityLogs' | 'listWorkflows'>;
  uiDistDir: string;
  token: string;
  host: string;
  port: number;
}

export interface WebBridge {
  close: () => Promise<void>;
  /** Resolves with the actually-bound port once the server is listening. */
  whenReady: Promise<number>;
  /** Best-effort current bound port (use `whenReady` when port was 0). */
  readonly port: number;
  /** Push a Server-Sent Event to every connected client. */
  broadcast: (channel: string, data: unknown) => void;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key) out[key] = part.slice(eq + 1).trim();
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
};

function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function sendJson(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    vary: 'Accept-Encoding',
  };
  const accepted = typeof req?.headers['accept-encoding'] === 'string' ? req.headers['accept-encoding'] : '';
  let responseBody = payload;
  if (payload.length >= JSON_COMPRESSION_MIN_BYTES) {
    if (accepted.includes('br')) {
      responseBody = brotliCompressSync(payload);
      headers['content-encoding'] = 'br';
    } else if (accepted.includes('gzip')) {
      responseBody = gzipSync(payload);
      headers['content-encoding'] = 'gzip';
    }
  }
  headers['content-length'] = String(responseBody.length);
  res.writeHead(status, headers);
  res.end(responseBody);
}

/**
 * Resolve the directory holding the built UI (`web.html` + assets), mirroring
 * window-lifecycle's packaged-vs-repo resolution. `appRootDir` is the main
 * process dist directory (`__dirname` of main.js).
 */
export function resolveWebUiDistDir(appRootDir: string): string {
  const packaged = join(appRootDir, 'ui');
  const repo = join(appRootDir, '..', '..', 'ui', 'dist');
  return existsSync(join(packaged, 'web.html')) ? packaged : repo;
}

export function startWebBridge(deps: WebBridgeDeps): WebBridge {
  const { logger, dispatch, messageBus, persistence, uiDistDir, token, host, port } = deps;
  const distRoot = normalize(uiDistDir);

  const clients = new Set<ServerResponse>();

  const broadcast = (channel: string, data: unknown): void => {
    if (clients.size === 0) return;
    const frame = `event: ${channel}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) {
      if (client.writableEnded || client.writableLength > SSE_DROP_BUFFER_BYTES) {
        clients.delete(client);
        client.destroy();
        continue;
      }
      client.write(frame);
    }
  };

  const cookieValid = (req: IncomingMessage): boolean => {
    const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
    return typeof cookie === 'string' && safeEqual(cookie, token);
  };

  const headerValid = (req: IncomingMessage): boolean => {
    const header = req.headers['x-invoker-token'];
    return typeof header === 'string' && safeEqual(header, token);
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    const rel = pathname === '/' ? 'web.html' : pathname.replace(/^\/+/, '');
    const resolved = normalize(join(distRoot, rel));
    if (resolved !== distRoot && !resolved.startsWith(distRoot + sep)) {
      sendJson(res, 403, { error: 'forbidden' });
      return;
    }
    if (!existsSync(resolved) || !statSync(resolved).isFile()) {
      // SPA fallback: unknown non-asset paths render the app shell.
      if (extname(resolved) === '') {
        serveStatic(res, '/');
        return;
      }
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const isShell = resolved.endsWith('web.html');
    res.writeHead(200, {
      'content-type': contentTypeFor(resolved),
      'cache-control': isShell ? 'no-cache' : 'public, max-age=31536000, immutable',
    });
    createReadStream(resolved).pipe(res);
  };

  const handleInvoke = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    let total = 0;
    let aborted = false;
    for await (const chunk of req) {
      total += (chunk as Buffer).length;
      if (total > MAX_INVOKE_BODY_BYTES) {
        aborted = true;
        sendJson(res, 413, { ok: false, error: { message: 'request body too large' } }, req);
        req.destroy();
        return;
      }
      chunks.push(chunk as Buffer);
    }
    if (aborted) return;

    let parsed: { channel?: unknown; args?: unknown };
    try {
      parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    } catch {
      sendJson(res, 400, { ok: false, error: { message: 'invalid JSON body' } }, req);
      return;
    }
    if (typeof parsed.channel !== 'string') {
      sendJson(res, 400, { ok: false, error: { message: 'missing "channel"' } }, req);
      return;
    }
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    try {
      const result = await dispatch(parsed.channel, args);
      sendJson(res, 200, { ok: true, result }, req);
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code) {
        sendJson(res, 200, { ok: false, error: { message: 'request failed', code } }, req);
        return;
      }
      logger?.warn(`web invoke failed for ${parsed.channel}`, {
        module: 'web-bridge',
      });
      sendJson(res, 200, { ok: false, error: { message: 'internal server error' } }, req);
    }
  };

  const handleEvents = (req: IncomingMessage, res: ServerResponse): void => {
    if (clients.size >= MAX_SSE_CLIENTS) {
      sendJson(res, 503, { error: 'too_many_clients' });
      return;
    }
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    clients.add(res);
    const cleanup = (): void => {
      clients.delete(res);
    };
    req.on('close', cleanup);
    res.on('error', cleanup);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        const pathname = url.pathname;

        if (method === 'POST' && pathname === '/invoke') {
          if (!cookieValid(req) && !headerValid(req)) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }
          await handleInvoke(req, res);
          return;
        }

        if (method === 'GET' && pathname === '/events') {
          if (!cookieValid(req) && !headerValid(req)) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }
          handleEvents(req, res);
          return;
        }

        if (method !== 'GET' && method !== 'HEAD') {
          sendJson(res, 405, { error: 'method_not_allowed' });
          return;
        }

        // Token handshake: exchange `?token=` for an HttpOnly cookie, then
        // redirect to a clean URL so the secret never lingers in history.
        const queryToken = url.searchParams.get('token');
        if (pathname === '/' && queryToken !== null) {
          if (!safeEqual(queryToken, token)) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }
          res.writeHead(302, {
            'set-cookie': `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/`,
            location: '/',
          });
          res.end();
          return;
        }

        if (!cookieValid(req)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        serveStatic(res, pathname);
      } catch (err) {
        logger?.error(`web bridge request error: ${err instanceof Error ? err.message : String(err)}`, {
          module: 'web-bridge',
        });
        if (!res.headersSent) sendJson(res, 500, { error: 'internal_error' });
      }
    })();
  });

  const unsubscribeOutput = messageBus.subscribe(Channels.TASK_OUTPUT, (payload: unknown) => {
    broadcast('invoker:task-output', payload);
  });

  let activityWatermark = 0;
  const activityTimer = setInterval(() => {
    try {
      const entries = persistence.getActivityLogs(activityWatermark, 200);
      if (entries.length === 0) return;
      activityWatermark = Math.max(activityWatermark, ...entries.map((e) => e.id));
      broadcast('invoker:activity-log', entries);
    } catch {
      // DB may be briefly locked; next tick retries.
    }
  }, ACTIVITY_POLL_INTERVAL_MS);
  activityTimer.unref?.();

  let workflowsSignature = '';
  const workflowsTimer = setInterval(() => {
    try {
      const workflows = persistence.listWorkflows();
      const signature = workflows.map((w) => `${w.id}:${w.status}:${w.updatedAt}`).join('|');
      if (signature === workflowsSignature) return;
      workflowsSignature = signature;
      broadcast('invoker:workflows-changed', workflows);
    } catch {
      // DB may be briefly locked; next tick retries.
    }
  }, WORKFLOWS_POLL_INTERVAL_MS);
  workflowsTimer.unref?.();

  const pingTimer = setInterval(() => {
    for (const client of clients) {
      if (!client.writableEnded) client.write(': ping\n\n');
    }
  }, SSE_PING_INTERVAL_MS);
  pingTimer.unref?.();

  const { promise: whenReady, resolve: resolveReady } = Promise.withResolvers<number>();
  server.listen(port, host, () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : port;
    logger?.info(`Web surface listening on http://${host}:${boundPort}`, { module: 'web-bridge' });
    resolveReady(boundPort);
  });

  const close = async (): Promise<void> => {
    clearInterval(activityTimer);
    clearInterval(workflowsTimer);
    clearInterval(pingTimer);
    unsubscribeOutput?.();
    for (const client of clients) client.end();
    clients.clear();
    const { promise, resolve } = Promise.withResolvers<void>();
    server.close(() => resolve());
    await promise;
  };

  return {
    close,
    whenReady,
    broadcast,
    get port(): number {
      const address = server.address();
      return typeof address === 'object' && address ? address.port : port;
    },
  };
}

/**
 * Localhost-only smoke hook for the live Slack reply path.
 *
 * Slack does not reliably deliver an app's own `app_mention` back to itself, so
 * the only way to exercise the real planning-mention → response-posting path
 * end-to-end against the running manager is to synthesize the event locally.
 *
 * This server:
 *  - is disabled unless `INVOKER_SLACK_HI_SMOKE` is set to a truthy value,
 *  - binds ONLY to 127.0.0.1 so it is never reachable off-box,
 *  - on `POST /smoke/hi` calls the injector, which posts a parent message to the
 *    lobby and feeds `hi` through the ordinary Slack reply path.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface HiSmokeResult {
  channel: string;
  threadTs: string;
}

export type HiSmokeInjector = (opts: { text?: string; user?: string }) => Promise<HiSmokeResult>;

export interface HiSmokeServerDeps {
  inject: HiSmokeInjector;
  log: (level: string, message: string) => void;
  env?: NodeJS.ProcessEnv;
}

export interface HiSmokeServer {
  port: number;
  host: string;
  close(): Promise<void>;
}

const LOOPBACK_HOST = '127.0.0.1';
const DEFAULT_PORT = 8765;
const MAX_BODY_BYTES = 4_096;

function isEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 && normalized !== '0' && normalized !== 'false' && normalized !== 'off';
}

function parseSmokeBody(body: string): { text?: string; user?: string } {
  const trimmed = body.trim();
  if (!trimmed) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      const text = typeof record.text === 'string' ? record.text : undefined;
      const user = typeof record.user === 'string' ? record.user : undefined;
      return { text, user };
    }
  } catch {
    // Ignore malformed bodies; fall back to defaults.
  }
  return {};
}

/**
 * Start the opt-in localhost smoke server. Returns `undefined` (no listener)
 * unless `INVOKER_SLACK_HI_SMOKE` is truthy.
 */
export async function maybeStartHiSmokeServer(deps: HiSmokeServerDeps): Promise<HiSmokeServer | undefined> {
  const env = deps.env ?? process.env;
  if (!isEnabled(env.INVOKER_SLACK_HI_SMOKE)) return undefined;

  const requestedPort = Number(env.INVOKER_SLACK_HI_SMOKE_PORT ?? DEFAULT_PORT);
  const port = Number.isInteger(requestedPort) && requestedPort >= 0 ? requestedPort : DEFAULT_PORT;

  const server = http.createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method !== 'POST' || !url.startsWith('/smoke/hi')) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'not found' }));
      return;
    }
    let body = '';
    let aborted = false;
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'body too large' }));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (aborted) return;
      const { text, user } = parseSmokeBody(body);
      deps
        .inject({ text: text ?? 'hi', user })
        .then((result) => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        })
        .catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          deps.log('error', `[hi-smoke] injection failed: ${message}`);
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: message }));
        });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK_HOST, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = address && typeof address === 'object' ? (address as AddressInfo).port : port;
  deps.log(
    'info',
    `[hi-smoke] localhost smoke hook listening on http://${LOOPBACK_HOST}:${boundPort}/smoke/hi (opt-in via INVOKER_SLACK_HI_SMOKE)`,
  );

  return {
    port: boundPort,
    host: LOOPBACK_HOST,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

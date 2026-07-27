/**
 * Opt-in, localhost-only smoke hook for the live Slack reply path.
 *
 * Slack does not reliably redeliver an app's own `app_mention` back to itself,
 * so there is no safe way to prove the live planning-mention → LLM-reply path
 * with a real bot self-mention. This server binds ONLY to 127.0.0.1 and is
 * started ONLY when `INVOKER_SLACK_HI_SMOKE` is set. A POST to `/hi` posts a
 * real parent message to the configured lobby and feeds `hi` through the exact
 * same mention route a human `@Invoker hi` would take, letting the ordinary
 * Slack response path post the reply in that same thread.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const HI_SMOKE_HOST = '127.0.0.1';
export const HI_SMOKE_DEFAULT_PORT = 8477;

export interface HiSmokeResult {
  channel: string;
  parentTs: string;
}

export interface HiSmokeServerOptions {
  /** Opt-in gate; when false the server is not started. */
  enabled: boolean;
  /** Loopback port (defaults to HI_SMOKE_DEFAULT_PORT, or 0 for ephemeral). */
  port?: number;
  /** Runs a single `hi` mention through the live reply path. */
  runHiSmoke: (opts: { text?: string }) => Promise<HiSmokeResult>;
  log: (level: string, message: string) => void;
}

export interface HiSmokeServerHandle {
  server: Server;
  /** Actual bound port (useful when port 0 requested an ephemeral one). */
  port(): number;
  stop(): Promise<void>;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > 64 * 1024) throw new Error('request body too large');
    chunks.push(buf);
  }
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

/** The request listener, exported so it can be unit-tested without a socket. */
export function createHiSmokeListener(
  runHiSmoke: HiSmokeServerOptions['runHiSmoke'],
  log: HiSmokeServerOptions['log'],
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      const respond = (status: number, body: unknown): void => {
        const json = JSON.stringify(body);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(json);
      };
      if (req.method !== 'POST' || (req.url ?? '').split('?')[0] !== '/hi') {
        respond(404, { ok: false, error: 'POST /hi only' });
        return;
      }
      try {
        const body = await readJsonBody(req);
        const text = typeof body.text === 'string' ? body.text : undefined;
        log('info', `[HI_SMOKE] injection requested text="${text ?? 'hi'}"`);
        const result = await runHiSmoke({ text });
        respond(200, { ok: true, ...result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log('error', `[HI_SMOKE] injection failed: ${message}`);
        respond(500, { ok: false, error: message });
      }
    })();
  };
}

/**
 * Start the loopback smoke server. Returns undefined when disabled so callers
 * can `?.stop()` unconditionally on shutdown.
 */
export function startHiSmokeServer(opts: HiSmokeServerOptions): Promise<HiSmokeServerHandle | undefined> {
  if (!opts.enabled) {
    opts.log('info', '[HI_SMOKE] disabled (set INVOKER_SLACK_HI_SMOKE to enable the localhost smoke hook)');
    return Promise.resolve(undefined);
  }
  const port = opts.port ?? HI_SMOKE_DEFAULT_PORT;
  const server = createServer(createHiSmokeListener(opts.runHiSmoke, opts.log));
  const { promise, resolve, reject } = Promise.withResolvers<HiSmokeServerHandle | undefined>();
  server.once('error', reject);
  // Bind ONLY to loopback — never expose the injection hook off-host.
  server.listen(port, HI_SMOKE_HOST, () => {
    server.removeListener('error', reject);
    const bound = server.address();
    const boundPort = typeof bound === 'object' && bound ? bound.port : port;
    opts.log('info', `[HI_SMOKE] listening on ${HI_SMOKE_HOST}:${boundPort} (POST /hi)`);
    resolve({
      server,
      port: () => {
        const addr = server.address();
        return typeof addr === 'object' && addr ? addr.port : boundPort;
      },
      stop: () => {
        const { promise: stopped, resolve: onClose } = Promise.withResolvers<void>();
        server.close(() => onClose());
        return stopped;
      },
    });
  });
  return promise;
}

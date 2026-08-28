/**
 * Localhost-only smoke inject for Slack mention e2e.
 *
 * Slack bots do not receive their own app_mention events, so live tests on a
 * bot-token host need a way to drive SlackSurface.injectMention while still
 * posting replies into a real Slack thread.
 *
 * Off by default. Enabled only when INVOKER_SLACK_ALLOW_LOCAL_SMOKE=1.
 * Binds exclusively to 127.0.0.1 and rejects non-loopback remotes.
 */

import http from 'node:http';
import type { InjectMentionRequest } from '@invoker/surfaces';

export const DEFAULT_SMOKE_INJECT_PORT = 4177;

export interface LocalSmokeInjectDeps {
  injectMention: (request: InjectMentionRequest) => Promise<void>;
  log: (level: string, message: string) => void;
  env?: NodeJS.ProcessEnv;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (Buffer.concat(chunks).length > 64 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  return address === '127.0.0.1'
    || address === '::1'
    || address === '::ffff:127.0.0.1';
}

function parseInjectBody(raw: string): InjectMentionRequest {
  const body = JSON.parse(raw) as Partial<InjectMentionRequest>;
  if (!body.channelId || !body.threadTs || !body.text || !body.userId) {
    throw new Error('body must include channelId, threadTs, text, and userId');
  }
  return {
    channelId: String(body.channelId),
    threadTs: String(body.threadTs),
    text: String(body.text),
    userId: String(body.userId),
  };
}

/** Start the inject listener when enabled; returns a no-op stop when disabled. */
export function startLocalSmokeInject(deps: LocalSmokeInjectDeps): () => void {
  const env = deps.env ?? process.env;
  if (env.INVOKER_SLACK_ALLOW_LOCAL_SMOKE !== '1') {
    return () => {};
  }

  const port = Number.parseInt(env.INVOKER_SLACK_SMOKE_PORT ?? String(DEFAULT_SMOKE_INJECT_PORT), 10);
  if (!Number.isFinite(port) || port <= 0) {
    throw new Error(`invalid INVOKER_SLACK_SMOKE_PORT: ${env.INVOKER_SLACK_SMOKE_PORT}`);
  }

  const server = http.createServer((req, res) => {
    void (async () => {
      const remote = req.socket.remoteAddress;
      if (!isLoopbackAddress(remote)) {
        deps.log('warn', `smoke inject rejected non-loopback remote=${remote ?? 'unknown'}`);
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'loopback only' }));
        return;
      }

      if (req.method !== 'POST' || req.url !== '/smoke/mention') {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
        return;
      }

      try {
        const request = parseInjectBody(await readBody(req));
        deps.log('info', `smoke inject mention channel=${request.channelId} thread_ts=${request.threadTs}`);
        await deps.injectMention(request);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        deps.log('error', `smoke inject failed: ${message}`);
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: message }));
      }
    })();
  });

  server.listen(port, '127.0.0.1', () => {
    deps.log('info', `local smoke inject listening on 127.0.0.1:${port}`);
  });

  return () => {
    server.close();
  };
}

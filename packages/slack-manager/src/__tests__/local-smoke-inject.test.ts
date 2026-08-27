import http from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SMOKE_INJECT_PORT, startLocalSmokeInject } from '../local-smoke-inject.js';

async function postJson(
  port: number,
  path: string,
  body: unknown,
  host = '127.0.0.1',
): Promise<{ status: number; json: { ok: boolean; error?: string } }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({
      host,
      port,
      path,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          json: JSON.parse(Buffer.concat(chunks).toString('utf8')) as { ok: boolean; error?: string },
        });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe('local smoke inject', () => {
  const stops: Array<() => void> = [];

  afterEach(() => {
    while (stops.length > 0) stops.pop()?.();
  });

  it('does nothing when INVOKER_SLACK_ALLOW_LOCAL_SMOKE is unset', async () => {
    const injectMention = vi.fn();
    // Use an unused port so a live host's smoke inject on 4177 cannot mask this.
    const unusedPort = 43177;
    const stop = startLocalSmokeInject({
      injectMention,
      log: () => {},
      env: {
        INVOKER_SLACK_SMOKE_PORT: String(unusedPort),
      },
    });
    stops.push(stop);
    await expect(postJson(unusedPort, '/smoke/mention', {
      channelId: 'C1',
      threadTs: '1.1',
      text: 'hi',
      userId: 'U1',
    })).rejects.toThrow();
    expect(injectMention).not.toHaveBeenCalled();
  });

  it('injects a mention on loopback POST /smoke/mention', async () => {
    const injectMention = vi.fn().mockResolvedValue(undefined);
    const port = 4178;
    const stop = startLocalSmokeInject({
      injectMention,
      log: () => {},
      env: {
        INVOKER_SLACK_ALLOW_LOCAL_SMOKE: '1',
        INVOKER_SLACK_SMOKE_PORT: String(port),
      },
    });
    stops.push(stop);
    await new Promise((r) => setTimeout(r, 50));

    const res = await postJson(port, '/smoke/mention', {
      channelId: 'CWF',
      threadTs: '1787782726.780619',
      text: 'Can you help me figure out why that failed and execute a fix with claude?',
      userId: 'U_SMOKE',
    });

    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    expect(injectMention).toHaveBeenCalledWith({
      channelId: 'CWF',
      threadTs: '1787782726.780619',
      text: 'Can you help me figure out why that failed and execute a fix with claude?',
      userId: 'U_SMOKE',
    });
  });

  it('rejects missing fields', async () => {
    const port = 4179;
    const stop = startLocalSmokeInject({
      injectMention: vi.fn(),
      log: () => {},
      env: {
        INVOKER_SLACK_ALLOW_LOCAL_SMOKE: '1',
        INVOKER_SLACK_SMOKE_PORT: String(port),
      },
    });
    stops.push(stop);
    await new Promise((r) => setTimeout(r, 50));

    const res = await postJson(port, '/smoke/mention', { channelId: 'C1' });
    expect(res.status).toBe(500);
    expect(res.json.ok).toBe(false);
    expect(res.json.error).toContain('channelId');
  });
});

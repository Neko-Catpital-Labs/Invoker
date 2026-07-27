import { describe, it, expect, vi } from 'vitest';
import { startHiSmokeServer, HI_SMOKE_HOST, type HiSmokeServerHandle } from '../hi-smoke-server.js';

const noop = (): void => {};

async function withServer(
  runHiSmoke: (opts: { text?: string }) => Promise<{ channel: string; parentTs: string }>,
  fn: (base: string) => Promise<void>,
): Promise<void> {
  const handle = (await startHiSmokeServer({ enabled: true, port: 0, runHiSmoke, log: noop })) as HiSmokeServerHandle;
  try {
    await fn(`http://${HI_SMOKE_HOST}:${handle.port()}`);
  } finally {
    await handle.stop();
  }
}

describe('startHiSmokeServer', () => {
  it('does not start when disabled', async () => {
    const runHiSmoke = vi.fn(async () => ({ channel: 'C1', parentTs: '1.1' }));
    const handle = await startHiSmokeServer({ enabled: false, port: 0, runHiSmoke, log: noop });
    expect(handle).toBeUndefined();
    expect(runHiSmoke).not.toHaveBeenCalled();
  });

  it('binds loopback and feeds POST /hi text through runHiSmoke', async () => {
    const runHiSmoke = vi.fn(async ({ text }: { text?: string }) => ({ channel: 'C0BCNM0UTFY', parentTs: `ts-${text}` }));
    await withServer(runHiSmoke, async (base) => {
      const res = await fetch(`${base}/hi`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: 'hi' }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, channel: 'C0BCNM0UTFY', parentTs: 'ts-hi' });
      expect(runHiSmoke).toHaveBeenCalledWith({ text: 'hi' });
    });
  });

  it('defaults to text=hi when the body omits it', async () => {
    const runHiSmoke = vi.fn(async () => ({ channel: 'C1', parentTs: '9.9' }));
    await withServer(runHiSmoke, async (base) => {
      const res = await fetch(`${base}/hi`, { method: 'POST' });
      expect(res.status).toBe(200);
      expect(runHiSmoke).toHaveBeenCalledWith({ text: undefined });
    });
  });

  it('rejects non-POST and unknown paths with 404 without invoking the reply path', async () => {
    const runHiSmoke = vi.fn(async () => ({ channel: 'C1', parentTs: '1.1' }));
    await withServer(runHiSmoke, async (base) => {
      const get = await fetch(`${base}/hi`, { method: 'GET' });
      expect(get.status).toBe(404);
      const wrong = await fetch(`${base}/nope`, { method: 'POST' });
      expect(wrong.status).toBe(404);
      expect(runHiSmoke).not.toHaveBeenCalled();
    });
  });

  it('returns 500 with the error message when the reply path throws', async () => {
    const runHiSmoke = vi.fn(async () => {
      throw new Error('No API key found for openai-codex');
    });
    await withServer(runHiSmoke, async (base) => {
      const res = await fetch(`${base}/hi`, { method: 'POST', body: '{}' });
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ ok: false, error: 'No API key found for openai-codex' });
    });
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';

import { maybeStartHiSmokeServer, type HiSmokeServer } from '../slack-hi-smoke.js';

const noopLog = (_level: string, _message: string): void => {};

describe('maybeStartHiSmokeServer', () => {
  let server: HiSmokeServer | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
  });

  it('stays disabled unless INVOKER_SLACK_HI_SMOKE is truthy', async () => {
    const inject = vi.fn();
    for (const value of [undefined, '', '0', 'false', 'off']) {
      const result = await maybeStartHiSmokeServer({
        inject,
        log: noopLog,
        env: value === undefined ? {} : { INVOKER_SLACK_HI_SMOKE: value },
      });
      expect(result).toBeUndefined();
    }
    expect(inject).not.toHaveBeenCalled();
  });

  it('binds only to loopback and feeds hi through the injector on POST /smoke/hi', async () => {
    const inject = vi.fn().mockResolvedValue({ channel: 'C123', threadTs: '1700000000.000100' });
    server = await maybeStartHiSmokeServer({
      inject,
      log: noopLog,
      env: { INVOKER_SLACK_HI_SMOKE: '1', INVOKER_SLACK_HI_SMOKE_PORT: '0' },
    });
    expect(server).toBeDefined();
    expect(server?.host).toBe('127.0.0.1');

    const res = await fetch(`http://127.0.0.1:${server!.port}/smoke/hi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    const payload = await res.json();
    expect(payload).toEqual({ ok: true, channel: 'C123', threadTs: '1700000000.000100' });
    expect(inject).toHaveBeenCalledWith({ text: 'hi', user: undefined });
  });

  it('passes through an explicit text override', async () => {
    const inject = vi.fn().mockResolvedValue({ channel: 'C1', threadTs: '1.2' });
    server = await maybeStartHiSmokeServer({
      inject,
      log: noopLog,
      env: { INVOKER_SLACK_HI_SMOKE: 'yes', INVOKER_SLACK_HI_SMOKE_PORT: '0' },
    });
    await fetch(`http://127.0.0.1:${server!.port}/smoke/hi`, {
      method: 'POST',
      body: JSON.stringify({ text: 'hello there', user: 'U9' }),
    });
    expect(inject).toHaveBeenCalledWith({ text: 'hello there', user: 'U9' });
  });

  it('returns 404 for non-POST or unknown paths', async () => {
    server = await maybeStartHiSmokeServer({
      inject: vi.fn(),
      log: noopLog,
      env: { INVOKER_SLACK_HI_SMOKE: '1', INVOKER_SLACK_HI_SMOKE_PORT: '0' },
    });
    const get = await fetch(`http://127.0.0.1:${server!.port}/smoke/hi`, { method: 'GET' });
    expect(get.status).toBe(404);
    const wrong = await fetch(`http://127.0.0.1:${server!.port}/other`, { method: 'POST' });
    expect(wrong.status).toBe(404);
  });

  it('surfaces injector failures as HTTP 500 without crashing the server', async () => {
    const inject = vi.fn().mockRejectedValue(new Error('lobby not_in_channel'));
    server = await maybeStartHiSmokeServer({
      inject,
      log: noopLog,
      env: { INVOKER_SLACK_HI_SMOKE: '1', INVOKER_SLACK_HI_SMOKE_PORT: '0' },
    });
    const res = await fetch(`http://127.0.0.1:${server!.port}/smoke/hi`, { method: 'POST', body: '{}' });
    expect(res.status).toBe(500);
    const payload = await res.json();
    expect(payload).toEqual({ ok: false, error: 'lobby not_in_channel' });
  });
});

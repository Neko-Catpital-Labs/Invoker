import { describe, it, expect, vi } from 'vitest';

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = { chat: { postMessage: vi.fn().mockResolvedValue({ ts: '1' }) }, auth: { test: vi.fn().mockResolvedValue({ user_id: 'U1' }) } };
    event = vi.fn();
    command = vi.fn();
    action = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
  }
  return { App: MockApp };
});

describe('scratch resolution probe', () => {
  it('can construct SlackSurface with mocked bolt', async () => {
    console.log('start');
    const { SlackSurface } = await import('@invoker/surfaces');
    const surface = new SlackSurface({
      botToken: 'x', appToken: 'x', signingSecret: 'x', channelId: 'C1',
    });
    expect(surface).toBeTruthy();
  });
});

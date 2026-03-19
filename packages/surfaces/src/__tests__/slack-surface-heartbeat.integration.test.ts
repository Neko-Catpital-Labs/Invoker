/**
 * Integration tests for SlackSurface heartbeat functionality during plan conversations.
 *
 * Tests verify that periodic heartbeat messages are sent to Slack threads
 * during long-running Cursor CLI processing, and that the interval is properly
 * cleared after completion or errors.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';

// ── Mock @slack/bolt ────────────────────────────────────────

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

interface ApiCall {
  method: 'postMessage' | 'update' | 'reactions.add' | 'reactions.remove';
  text?: string;
  channel: string;
  ts?: string;
}

const apiCalls: ApiCall[] = [];

vi.mock('@slack/bolt', () => {
  class MockApp {
    _commandHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _eventHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => {
      this._commandHandlers.push({ pattern: name, handler });
    });
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    event = vi.fn((name: string, handler: Function) => {
      this._eventHandlers.push({ pattern: name, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockImplementation(async ({ channel, text }) => {
          const ts = `msg.${apiCalls.length}`;
          apiCalls.push({ method: 'postMessage', channel, text, ts });
          return { ts, ok: true };
        }),
        update: vi.fn().mockImplementation(async ({ channel, ts, text }) => {
          apiCalls.push({ method: 'update', channel, ts, text });
          return { ok: true };
        }),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }
  return { App: MockApp };
});

const mockSendMessage = vi.fn();
const mockPlanConversation = {
  sendMessage: mockSendMessage,
  submittedPlan: null as any,
  planSubmitted: false,
  init: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../slack/plan-conversation.js', () => ({
  PlanConversation: vi.fn(() => mockPlanConversation),
}));

// ── Helper ──────────────────────────────────────────────────

async function triggerMention(surface: SlackSurface, text: string): Promise<void> {
  const app = surface.getApp() as any;
  const mentionHandler = app._eventHandlers.find(
    (h: MockHandler) => h.pattern === 'app_mention',
  )?.handler;
  const say = vi.fn().mockImplementation(async ({ text: t, thread_ts }) => {
    const ts = `msg.${apiCalls.length}`;
    apiCalls.push({ method: 'postMessage', channel: 'C-test', text: t, ts });
    return { ts, ok: true };
  });
  await mentionHandler({
    event: { text: `<@UBOT> ${text}`, ts: '1000.001', thread_ts: undefined, user: 'U1' },
    say,
  });
}

// ── Tests ───────────────────────────────────────────────────

describe('SlackSurface Heartbeat - Integration Tests', () => {
  let surface: SlackSurface;

  beforeEach(() => {
    vi.useFakeTimers();
    apiCalls.length = 0;
    mockSendMessage.mockReset();
    mockPlanConversation.submittedPlan = null;
    mockPlanConversation.planSubmitted = false;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (surface) await surface.stop();
  });

  it('sends heartbeat messages at configured interval during processing', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalMs: 5_000,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    let resolveSendMessage!: (value: string) => void;
    mockSendMessage.mockReturnValue(
      new Promise<string>((resolve) => { resolveSendMessage = resolve; }),
    );

    await surface.start(async () => {});

    const mentionPromise = triggerMention(surface, 'do something complex');

    // Advance past 2 heartbeat intervals
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(5_000);

    // Resolve the sendMessage
    resolveSendMessage('Done!');
    await mentionPromise;

    const heartbeats = apiCalls.filter(c => c.text?.includes('Still thinking'));
    expect(heartbeats.length).toBe(2);
    expect(heartbeats[0].method).toBe('postMessage');
  });

  it('clears heartbeat timer after successful response', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalMs: 5_000,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    let resolveSendMessage!: (value: string) => void;
    mockSendMessage.mockReturnValue(
      new Promise<string>((resolve) => { resolveSendMessage = resolve; }),
    );

    await surface.start(async () => {});

    const mentionPromise = triggerMention(surface, 'quick task');

    // One heartbeat fires
    await vi.advanceTimersByTimeAsync(5_000);

    // Resolve
    resolveSendMessage('Done!');
    await mentionPromise;

    // Clear apiCalls and advance more — no more heartbeats should fire
    const countBefore = apiCalls.filter(c => c.text?.includes('Still thinking')).length;
    await vi.advanceTimersByTimeAsync(15_000);
    const countAfter = apiCalls.filter(c => c.text?.includes('Still thinking')).length;
    expect(countAfter).toBe(countBefore);
  });

  it('clears heartbeat timer on error', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalMs: 5_000,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    let rejectSendMessage!: (err: Error) => void;
    mockSendMessage.mockReturnValue(
      new Promise<string>((_, reject) => { rejectSendMessage = reject; }),
    );

    await surface.start(async () => {});

    const mentionPromise = triggerMention(surface, 'will fail');

    await vi.advanceTimersByTimeAsync(5_000);

    rejectSendMessage(new Error('Cursor CLI timeout'));
    await mentionPromise;

    // After error, no more heartbeats
    const countBefore = apiCalls.filter(c => c.text?.includes('Still thinking')).length;
    await vi.advanceTimersByTimeAsync(15_000);
    const countAfter = apiCalls.filter(c => c.text?.includes('Still thinking')).length;
    expect(countAfter).toBe(countBefore);
  });

  it('does not send heartbeats when interval is 0', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalMs: 0,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    mockSendMessage.mockResolvedValue('Response');

    await surface.start(async () => {});
    await triggerMention(surface, 'quick');

    const heartbeats = apiCalls.filter(c => c.text?.includes('Still thinking'));
    expect(heartbeats.length).toBe(0);
  });

  it('does not send heartbeats when using default (60s) and response is fast', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    mockSendMessage.mockResolvedValue('Fast response');

    await surface.start(async () => {});
    await triggerMention(surface, 'quick');

    const heartbeats = apiCalls.filter(c => c.text?.includes('Still thinking'));
    expect(heartbeats.length).toBe(0);
  });
});

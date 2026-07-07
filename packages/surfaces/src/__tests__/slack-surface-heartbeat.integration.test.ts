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
  submittedPlanText: null as any,
  planSubmitted: false,
  conversationMode: 'plan' as const,
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

async function triggerThreadReply(surface: SlackSurface, text: string, threadTs = '1000.001'): Promise<void> {
  const app = surface.getApp() as any;
  const messageHandler = app._eventHandlers.find(
    (h: MockHandler) => h.pattern === 'message',
  )?.handler;
  const say = vi.fn().mockImplementation(async ({ text: t, thread_ts }) => {
    const ts = `msg.${apiCalls.length}`;
    apiCalls.push({ method: 'postMessage', channel: 'C-test', text: t, ts });
    return { ts, ok: true };
  });
  await messageHandler({
    event: { text, ts: '1000.002', thread_ts: threadTs, user: 'U1', channel: 'C-test' },
    say,
  });
}

function abortError(message = 'Planner turn was superseded'): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

// ── Tests ───────────────────────────────────────────────────

describe('SlackSurface Heartbeat - Integration Tests', () => {
  let surface: SlackSurface;

  beforeEach(() => {
    vi.useFakeTimers();
    apiCalls.length = 0;
    mockSendMessage.mockReset();
    mockPlanConversation.submittedPlanText = null;
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
      planningHeartbeatIntervalSeconds: 5,
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
      planningHeartbeatIntervalSeconds: 5,
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
      planningHeartbeatIntervalSeconds: 5,
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

  it('aborts a superseded same-thread turn and suppresses its stale abort error', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalSeconds: 0,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    let rejectFirst!: (err: Error) => void;
    let firstStarted!: (signal: AbortSignal) => void;
    const firstStartedPromise = new Promise<AbortSignal>((resolve) => { firstStarted = resolve; });

    mockSendMessage
      .mockImplementationOnce((_text: string, signal?: AbortSignal) => {
        firstStarted(signal!);
        return new Promise<string>((_, reject) => { rejectFirst = reject; });
      })
      .mockResolvedValueOnce('Replacement response');

    await surface.start(async () => {});

    const firstTurn = triggerMention(surface, 'original request');
    const firstSignal = await firstStartedPromise;
    expect(firstSignal.aborted).toBe(false);

    await triggerThreadReply(surface, 'replacement request');

    expect(firstSignal.aborted).toBe(true);
    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(mockSendMessage.mock.calls[1][1]).toBeInstanceOf(AbortSignal);

    rejectFirst(abortError());
    await firstTurn;

    expect(apiCalls.some(c => c.text === 'Replacement response')).toBe(true);
    expect(apiCalls.some(c => c.text?.startsWith('Error:'))).toBe(false);
  });

  it('does not send heartbeats when interval is 0', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      planningHeartbeatIntervalSeconds: 0,
      enableImmediateAck: false,
      useTypingIndicator: false,
    });

    mockSendMessage.mockResolvedValue('Response');

    await surface.start(async () => {});
    await triggerMention(surface, 'quick');

    const heartbeats = apiCalls.filter(c => c.text?.includes('Still thinking'));
    expect(heartbeats.length).toBe(0);
  });

  it('does not send heartbeats when using default (120s) and response is fast', async () => {
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

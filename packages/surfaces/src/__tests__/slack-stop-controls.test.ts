import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { PlannerAbortedError } from '../slack/plan-conversation.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _actionHandlers: MockHandler[] = [];
    _eventHandlers: MockHandler[] = [];
    command = vi.fn();
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    event = vi.fn((pattern: string, handler: Function) => {
      this._eventHandlers.push({ pattern, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'posted.1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [] }),
      },
    };
  }

  return { App: MockApp };
});

type FakeConversation = {
  sendMessage: ReturnType<typeof vi.fn>;
  abortTurn: ReturnType<typeof vi.fn>;
  isTurnInFlight: ReturnType<typeof vi.fn>;
  getTurnStartedAt: ReturnType<typeof vi.fn>;
  getQueuedTurnCount: ReturnType<typeof vi.fn>;
  runPlanConversion: ReturnType<typeof vi.fn>;
  getDraftedPlan: ReturnType<typeof vi.fn>;
  history: readonly { role: 'user' | 'assistant'; content: string }[];
  lastTurnDraftPlanText: string | null;
  lastTurnPlanIntentSignal: null;
  conversationMode: 'agent' | 'plan';
  planSubmitted: boolean;
  submittedPlanText: string | null;
  workingDir?: string;
};

function makeConversation(overrides: Partial<FakeConversation> = {}): FakeConversation {
  return {
    sendMessage: vi.fn().mockResolvedValue('ok'),
    abortTurn: vi.fn().mockReturnValue(true),
    isTurnInFlight: vi.fn().mockReturnValue(false),
    getTurnStartedAt: vi.fn().mockReturnValue(Date.now() - 4_000),
    getQueuedTurnCount: vi.fn().mockReturnValue(0),
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: vi.fn().mockReturnValue(null),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: 'agent',
    planSubmitted: false,
    submittedPlanText: null,
    ...overrides,
  };
}

function appInternals(surface: SlackSurface): any {
  return surface.getApp() as any;
}

function seedConversation(surface: SlackSurface, threadTs: string, conversation: FakeConversation): void {
  (surface as any).planConversations.set(threadTs, conversation);
}

function mentionHandler(surface: SlackSurface): Function {
  const handler = appInternals(surface)._eventHandlers.find((entry: MockHandler) => entry.pattern === 'app_mention');
  if (!handler) throw new Error('Missing app_mention handler');
  return handler.handler;
}

function stopActionHandler(surface: SlackSurface): Function {
  const handler = appInternals(surface)._actionHandlers.find((entry: MockHandler) =>
    entry.pattern instanceof RegExp && entry.pattern.test('stop_turn:thread-1'));
  if (!handler) throw new Error('Missing stop_turn action handler');
  return handler.handler;
}

async function sendMention(
  surface: SlackSurface,
  text: string,
  threadTs = 'thread-1',
): Promise<ReturnType<typeof vi.fn>> {
  const say = vi.fn().mockResolvedValue({ ts: 'say.1' });
  await mentionHandler(surface)({
    event: {
      text: `<@U_BOT> ${text}`,
      ts: threadTs,
      thread_ts: threadTs,
      user: 'U1',
      channel: 'C1',
    },
    say,
  });
  return say;
}

describe('SlackSurface stop controls', () => {
  let surface: SlackSurface;

  beforeEach(async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C1',
      enableImmediateAck: false,
      useTypingIndicator: false,
      log: () => {},
    });
    await surface.start(async () => {});
  });

  afterEach(async () => {
    await surface.stop();
  });

  it('aborts an in-flight turn on an exact stop message, enqueues no new turn, and posts the stopped notice', async () => {
    const conversation = makeConversation({
      isTurnInFlight: vi.fn().mockReturnValue(true),
      getTurnStartedAt: vi.fn().mockReturnValue(Date.now() - 4_200),
      getQueuedTurnCount: vi.fn().mockReturnValue(2),
    });
    seedConversation(surface, 'thread-1', conversation);

    const say = await sendMention(surface, 'stop');

    expect(conversation.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation.sendMessage).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/Stopped the in-flight turn after \d+ seconds\./),
      thread_ts: 'thread-1',
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Dropped 2 queued messages.'),
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Work the agent already executed was not rolled back.'),
    }));
  });

  it('aborts the same in-flight turn from the heartbeat Stop button', async () => {
    const conversation = makeConversation({
      isTurnInFlight: vi.fn().mockReturnValue(true),
      getTurnStartedAt: vi.fn().mockReturnValue(Date.now() - 1_700),
      getQueuedTurnCount: vi.fn().mockReturnValue(1),
    });
    seedConversation(surface, 'thread-1', conversation);

    const respond = vi.fn().mockResolvedValue(undefined);
    await stopActionHandler(surface)({
      action: { type: 'button', action_id: 'stop_turn:thread-1' },
      body: {
        channel: { id: 'C1' },
        message: { thread_ts: 'thread-1' },
        user: { id: 'U1' },
      },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    const app = appInternals(surface);
    expect(conversation.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation.sendMessage).not.toHaveBeenCalled();
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C1',
      thread_ts: 'thread-1',
      text: expect.stringContaining('Dropped 1 queued message.'),
    }));
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Work the agent already executed was not rolled back.'),
    }));
    expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({
      text: 'There is nothing to stop in this thread.',
    }));
  });

  it('treats stop as the existing negation path when the thread is idle', async () => {
    const conversation = makeConversation({
      isTurnInFlight: vi.fn().mockReturnValue(false),
    });
    seedConversation(surface, 'thread-1', conversation);
    (surface as any).pendingConfirms.set('thread-1', { kind: 'restart' });

    const say = await sendMention(surface, 'stop');

    expect(conversation.abortTurn).not.toHaveBeenCalled();
    expect(conversation.sendMessage).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Cancelled.',
      thread_ts: 'thread-1',
    }));
  });

  it('posts the stopped notice instead of an error reply when sendMessage rejects with PlannerAbortedError', async () => {
    const conversation = makeConversation({
      sendMessage: vi.fn().mockRejectedValue(new PlannerAbortedError('user requested stop from Slack')),
      getTurnStartedAt: vi.fn().mockReturnValue(Date.now() - 2_300),
      getQueuedTurnCount: vi.fn().mockReturnValue(0),
    });
    seedConversation(surface, 'thread-1', conversation);

    const say = await sendMention(surface, 'continue');

    expect(conversation.sendMessage).toHaveBeenCalledWith('continue');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Work the agent already executed was not rolled back.'),
      thread_ts: 'thread-1',
    }));
    expect(say).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringMatching(/^Error:/),
    }));
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { PlannerAbortedError } from '../slack/plan-conversation.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

interface MockConversationState {
  inFlight: boolean;
  queuedTurns: number;
  startedAt: number | null;
  pendingReject?: (error: Error) => void;
}

type MockConversation = {
  sendMessage: ReturnType<typeof vi.fn>;
  runPlanConversion: ReturnType<typeof vi.fn>;
  getDraftedPlan: () => string | null;
  abortTurn: ReturnType<typeof vi.fn>;
  isTurnInFlight: ReturnType<typeof vi.fn>;
  getQueuedTurnCount: ReturnType<typeof vi.fn>;
  getTurnStartedAt: ReturnType<typeof vi.fn>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastTurnDraftPlanText: string | null;
  lastTurnPlanIntentSignal: null;
  conversationMode: 'plan';
  planSubmitted: boolean;
  submittedPlanText: string | null;
  state: MockConversationState;
};

const postedMessages: Array<{ channel?: string; text?: string; thread_ts?: string; blocks?: unknown[] }> = [];
const conversationByThread = new Map<string, MockConversation>();
let nextConversationFactory: ((threadTs: string) => MockConversation) | null = null;

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _commandHandlers: MockHandler[] = [];
    command = vi.fn((pattern: string, handler: Function) => this._commandHandlers.push({ pattern, handler }));
    event = vi.fn((pattern: string, handler: Function) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn((pattern: string | RegExp, handler: Function) => this._actionHandlers.push({ pattern, handler }));
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      chat: {
        postMessage: vi.fn().mockImplementation(async (message: { channel?: string; text?: string; thread_ts?: string; blocks?: unknown[] }) => {
          postedMessages.push(message);
          return { ts: `posted-${postedMessages.length}`, ok: true };
        }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }),
      },
    };
  }
  return { App: MockApp };
});

vi.mock('../slack/plan-conversation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slack/plan-conversation.js')>();
  return {
    ...actual,
    PlanConversation: vi.fn((config: { threadTs?: string }) => {
      const threadTs = config.threadTs ?? `thread-${conversationByThread.size + 1}`;
      const conversation = (nextConversationFactory ?? defaultConversationFactory)(threadTs);
      conversationByThread.set(threadTs, conversation);
      return conversation;
    }),
  };
});

function defaultConversationFactory(threadTs: string): MockConversation {
  const state: MockConversationState = {
    inFlight: false,
    queuedTurns: 0,
    startedAt: null,
  };
  const sendMessage = vi.fn().mockImplementation(async (text: string) => {
    state.inFlight = true;
    state.startedAt = Date.now();
    return `reply:${threadTs}:${text}`;
  });
  const conversation: MockConversation = {
    sendMessage,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: () => null,
    abortTurn: vi.fn(() => false),
    isTurnInFlight: vi.fn(() => state.inFlight),
    getQueuedTurnCount: vi.fn(() => state.queuedTurns),
    getTurnStartedAt: vi.fn(() => state.startedAt),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: 'plan',
    planSubmitted: false,
    submittedPlanText: null,
    state,
  };
  return conversation;
}

function pendingConversationFactory(threadTs: string): MockConversation {
  const state: MockConversationState = {
    inFlight: false,
    queuedTurns: 2,
    startedAt: null,
  };
  const sendMessage = vi.fn().mockImplementation(() => new Promise<string>((_, reject) => {
    state.inFlight = true;
    state.startedAt = Date.now() - 12_000;
    state.pendingReject = reject;
  }));
  const conversation: MockConversation = {
    sendMessage,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: () => null,
    abortTurn: vi.fn((reason?: string) => {
      if (!state.inFlight) return false;
      state.inFlight = false;
      state.pendingReject?.(new PlannerAbortedError(reason));
      return true;
    }),
    isTurnInFlight: vi.fn(() => state.inFlight),
    getQueuedTurnCount: vi.fn(() => state.queuedTurns),
    getTurnStartedAt: vi.fn(() => state.startedAt),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: 'plan',
    planSubmitted: false,
    submittedPlanText: null,
    state,
  };
  return conversation;
}

function abortedReplyConversationFactory(threadTs: string): MockConversation {
  const state: MockConversationState = {
    inFlight: false,
    queuedTurns: 0,
    startedAt: null,
  };
  const sendMessage = vi.fn().mockImplementation(async () => {
    state.inFlight = true;
    state.startedAt = Date.now() - 5_000;
    state.inFlight = false;
    throw new PlannerAbortedError('planner aborted upstream');
  });
  const conversation: MockConversation = {
    sendMessage,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: () => null,
    abortTurn: vi.fn(() => false),
    isTurnInFlight: vi.fn(() => state.inFlight),
    getQueuedTurnCount: vi.fn(() => state.queuedTurns),
    getTurnStartedAt: vi.fn(() => state.startedAt),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: 'plan',
    planSubmitted: false,
    submittedPlanText: null,
    state,
  };
  return conversation;
}

function handler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: MockHandler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

function actionHandler(surface: SlackSurface, actionId: string): Function {
  const found = (surface.getApp() as any)._actionHandlers.find((entry: MockHandler) =>
    typeof entry.pattern === 'string' ? entry.pattern === actionId : entry.pattern.test(actionId));
  if (!found) throw new Error(`Missing ${actionId} action handler`);
  return found.handler;
}

async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition never became true');
}

function buildSurface(): SlackSurface {
  return new SlackSurface({
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test',
    channelId: 'C_LOBBY',
    lobbyChannelId: 'C_LOBBY',
    defaultRepoUrl: 'https://github.com/example/repo.git',
    enableImmediateAck: false,
    planningHeartbeatIntervalSeconds: 0,
    log: () => {},
  });
}

describe('Slack stop controls', () => {
  let surface: SlackSurface;

  beforeEach(async () => {
    postedMessages.length = 0;
    conversationByThread.clear();
    nextConversationFactory = null;
    surface = buildSurface();
    await surface.start(async () => {});
  });

  afterEach(async () => {
    nextConversationFactory = null;
    await surface.stop();
  });

  it('aborts an in-flight turn from an exact stop mention without queueing a new turn', async () => {
    nextConversationFactory = pendingConversationFactory;
    const mention = handler(surface, 'app_mention');
    const firstSay = vi.fn().mockResolvedValue({ ts: 'say-1' });
    const stopSay = vi.fn().mockResolvedValue({ ts: 'say-2' });

    const firstTurn = mention({
      event: { text: '<@UBOT> investigate this', ts: 'thread-stop', user: 'U1', channel: 'C_LOBBY' },
      say: firstSay,
    });

    await flushUntil(() => conversationByThread.has('thread-stop')
      && conversationByThread.get('thread-stop')!.sendMessage.mock.calls.length === 1);

    const stopTurn = mention({
      event: { text: '<@UBOT> stop', ts: 'event-stop', thread_ts: 'thread-stop', user: 'U1', channel: 'C_LOBBY' },
      say: stopSay,
    });

    await Promise.all([firstTurn, stopTurn]);

    const conversation = conversationByThread.get('thread-stop')!;
    expect(conversation.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation.sendMessage).toHaveBeenCalledTimes(1);
    expect(stopSay).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Dropped 2 queued messages. Work the agent already executed was not rolled back.'),
    }));
    expect(firstSay).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Error:'),
    }));
  });

  it('aborts an in-flight turn from the stop button action', async () => {
    nextConversationFactory = pendingConversationFactory;
    const mention = handler(surface, 'app_mention');
    const stopAction = actionHandler(surface, 'stop_turn:thread-button');
    const ack = vi.fn().mockResolvedValue(undefined);
    const respond = vi.fn().mockResolvedValue(undefined);

    const firstTurn = mention({
      event: { text: '<@UBOT> keep going', ts: 'thread-button', user: 'U1', channel: 'C_LOBBY' },
      say: vi.fn().mockResolvedValue({ ts: 'say-1' }),
    });

    await flushUntil(() => conversationByThread.has('thread-button')
      && conversationByThread.get('thread-button')!.sendMessage.mock.calls.length === 1);

    await stopAction({
      action: { type: 'button', action_id: 'stop_turn:thread-button', value: 'thread-button' },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'heartbeat-1', thread_ts: 'thread-button' }, user: { id: 'U1' } },
      ack,
      respond,
    });
    await firstTurn;

    const conversation = conversationByThread.get('thread-button')!;
    expect(ack).toHaveBeenCalled();
    expect(conversation.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation.sendMessage).toHaveBeenCalledTimes(1);
    expect(postedMessages).toContainEqual(expect.objectContaining({
      channel: 'C_LOBBY',
      thread_ts: 'thread-button',
      text: expect.stringContaining('Dropped 2 queued messages. Work the agent already executed was not rolled back.'),
    }));
    expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'There is nothing to stop.' }));
  });

  it('treats stop as the existing negation path when no turn is in flight', async () => {
    const mention = handler(surface, 'app_mention');
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    await mention({
      event: { text: '<@UBOT> /plan add a REST endpoint', ts: 'thread-negation', user: 'U1', channel: 'C_LOBBY' },
      say,
    });
    say.mockClear();

    await mention({
      event: { text: '<@UBOT> stop', ts: 'negation-stop', thread_ts: 'thread-negation', user: 'U1', channel: 'C_LOBBY' },
      say,
    });

    expect(conversationByThread.size).toBe(0);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cancelled.', thread_ts: 'thread-negation' }));
  });

  it('posts a stopped notice for PlannerAbortedError instead of an error reply', async () => {
    nextConversationFactory = abortedReplyConversationFactory;
    const mention = handler(surface, 'app_mention');
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    await mention({
      event: { text: '<@UBOT> investigate aborts', ts: 'thread-aborted', user: 'U1', channel: 'C_LOBBY' },
      say,
    });

    const texts = say.mock.calls.map(([message]) => message.text as string);
    expect(texts.some((text) => text.startsWith('Error:'))).toBe(false);
    expect(texts.some((text) => text.includes('Work the agent already executed was not rolled back.'))).toBe(true);
    expect(texts.some((text) => text.includes('Stopped after 5 seconds.'))).toBe(true);
  });
});

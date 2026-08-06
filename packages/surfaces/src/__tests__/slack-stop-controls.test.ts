import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { PlannerAbortedError, type TurnAbortSnapshot } from '../slack/plan-conversation.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

type ConversationMock = {
  abortTurn: ReturnType<typeof vi.fn>;
  conversationMode: 'plan';
  getDraftedPlan: () => string | null;
  getLastAbortSnapshot: ReturnType<typeof vi.fn>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  isTurnInFlight: ReturnType<typeof vi.fn>;
  lastTurnDraftPlanText: string | null;
  lastTurnPlanIntentSignal: null;
  planSubmitted: false;
  runPlanConversion: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  submittedPlanText: null;
  workingDir?: string;
};

const conversationInstances = new Map<string, ConversationMock>();
let conversationFactory: ((config: { threadTs?: string }) => ConversationMock) | undefined;
let postedMessages: Array<{ channel: string; text?: string; thread_ts?: string; blocks?: unknown[] }> = [];

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
        postMessage: vi.fn().mockImplementation(async (message: { channel: string; text?: string; thread_ts?: string; blocks?: unknown[] }) => {
          postedMessages.push(message);
          return { ok: true, ts: `msg-${postedMessages.length}` };
        }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true }),
      },
    };
  }

  return { App: MockApp };
});

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack/plan-conversation.js')>()),
  PlanConversation: vi.fn((config: { threadTs?: string }) => {
    const instance = conversationFactory?.(config) ?? createResolvedConversation();
    if (config.threadTs) {
      conversationInstances.set(config.threadTs, instance);
    }
    return instance;
  }),
}));

function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function getMentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((entry: MockHandler) => entry.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('Missing app_mention handler');
  return handler;
}

function getActionHandler(surface: SlackSurface, matcher: RegExp): Function {
  const app = surface.getApp() as any;
  const handler = app._actionHandlers.find((entry: MockHandler) => entry.pattern instanceof RegExp && matcher.source === entry.pattern.source)?.handler;
  if (!handler) throw new Error(`Missing action handler: ${matcher}`);
  return handler;
}

function createResolvedConversation(): ConversationMock {
  return {
    abortTurn: vi.fn().mockReturnValue(false),
    conversationMode: 'plan',
    getDraftedPlan: () => null,
    getLastAbortSnapshot: vi.fn().mockReturnValue(null),
    history: [],
    isTurnInFlight: vi.fn().mockReturnValue(false),
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    planSubmitted: false,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    sendMessage: vi.fn().mockResolvedValue('planner reply'),
    submittedPlanText: null,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAbortableConversation(snapshotOverrides: Partial<TurnAbortSnapshot> = {}): ConversationMock {
  const pendingTurn = createDeferred<string>();
  let inFlight = false;
  let lastAbortSnapshot: TurnAbortSnapshot | null = null;

  const instance: ConversationMock = {
    abortTurn: vi.fn().mockImplementation((reason?: string) => {
      if (!inFlight) return false;
      inFlight = false;
      lastAbortSnapshot = {
        abortId: 1,
        droppedQueuedMessages: 0,
        elapsedMs: 4_200,
        reason,
        startedAt: Date.now() - 4_200,
        ...snapshotOverrides,
      };
      pendingTurn.reject(new PlannerAbortedError(reason));
      return true;
    }),
    conversationMode: 'plan',
    getDraftedPlan: () => null,
    getLastAbortSnapshot: vi.fn().mockImplementation(() => lastAbortSnapshot),
    history: [],
    isTurnInFlight: vi.fn().mockImplementation(() => inFlight),
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    planSubmitted: false,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    sendMessage: vi.fn().mockImplementation(async (text: string) => {
      instance.history.push({ role: 'user', content: text });
      inFlight = true;
      return pendingTurn.promise;
    }),
    submittedPlanText: null,
  };
  return instance;
}

function createAlreadyAbortedConversation(snapshotOverrides: Partial<TurnAbortSnapshot> = {}): ConversationMock {
  const snapshot: TurnAbortSnapshot = {
    abortId: 7,
    droppedQueuedMessages: 2,
    elapsedMs: 6_100,
    reason: 'user requested stop from Slack',
    startedAt: Date.now() - 6_100,
    ...snapshotOverrides,
  };
  return {
    abortTurn: vi.fn().mockReturnValue(false),
    conversationMode: 'plan',
    getDraftedPlan: () => null,
    getLastAbortSnapshot: vi.fn().mockReturnValue(snapshot),
    history: [],
    isTurnInFlight: vi.fn().mockReturnValue(false),
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    planSubmitted: false,
    runPlanConversion: vi.fn().mockResolvedValue(''),
    sendMessage: vi.fn().mockRejectedValue(new PlannerAbortedError('user requested stop from Slack')),
    submittedPlanText: null,
  };
}

function createSurface(): SlackSurface {
  return new SlackSurface({
    defaultRepoUrl: 'https://github.com/example/repo.git',
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test-secret',
    channelId: 'C-test',
    enableImmediateAck: false,
    useTypingIndicator: false,
    planningHeartbeatIntervalSeconds: 0,
  });
}

describe('Slack stop controls', () => {
  let surface: SlackSurface;

  beforeEach(async () => {
    conversationFactory = undefined;
    conversationInstances.clear();
    postedMessages = [];
    surface = createSurface();
    await surface.start(async () => {});
  });

  afterEach(async () => {
    await surface.stop();
  });

  it('aborts an in-flight turn on exact "stop", does not enqueue a new turn, and posts one stopped notice', async () => {
    conversationFactory = () => createAbortableConversation({ droppedQueuedMessages: 0 });
    const mention = getMentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    const firstTurn = mention({
      event: { text: '<@UBOT> keep planning', ts: 'thread-stop-message', user: 'U1', channel: 'C-test' },
      say,
    });
    await flushAsync();

    const conversation = conversationInstances.get('thread-stop-message');
    expect(conversation).toBeDefined();
    expect(conversation?.sendMessage).toHaveBeenCalledTimes(1);

    await mention({
      event: { text: '<@UBOT> stop', ts: 'reply-stop', thread_ts: 'thread-stop-message', user: 'U1', channel: 'C-test' },
      say,
    });
    await firstTurn;

    expect(conversation?.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation?.sendMessage).toHaveBeenCalledTimes(1);

    const stopNotices = say.mock.calls
      .map(([message]) => message?.text)
      .filter((text): text is string => typeof text === 'string' && text.includes('Work the agent already executed was not rolled back.'));
    expect(stopNotices).toHaveLength(1);
    expect(stopNotices[0]).toContain('dropped 0 queued message(s)');
  });

  it('aborts an in-flight turn from the stop button and posts one stopped notice', async () => {
    conversationFactory = () => createAbortableConversation({ droppedQueuedMessages: 1, abortId: 3 });
    const mention = getMentionHandler(surface);
    const action = getActionHandler(surface, /^stop_turn:/);
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    const firstTurn = mention({
      event: { text: '<@UBOT> keep planning', ts: 'thread-stop-button', user: 'U1', channel: 'C-test' },
      say,
    });
    await flushAsync();

    const conversation = conversationInstances.get('thread-stop-button');
    expect(conversation?.sendMessage).toHaveBeenCalledTimes(1);

    const respond = vi.fn().mockResolvedValue(undefined);
    await action({
      action: { type: 'button', action_id: 'stop_turn:thread-stop-button', value: 'thread-stop-button' },
      body: { channel: { id: 'C-test' }, user: { id: 'U1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });
    await firstTurn;

    expect(conversation?.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(conversation?.sendMessage).toHaveBeenCalledTimes(1);
    expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ text: expect.stringContaining('nothing to stop') }));

    const stopNotices = postedMessages.filter((message) =>
      message.text?.includes('Work the agent already executed was not rolled back.'));
    expect(stopNotices).toHaveLength(1);
    expect(stopNotices[0]?.text).toContain('dropped 1 queued message(s)');
  });

  it('keeps the existing negation path for "stop" when no turn is in flight', async () => {
    const mention = getMentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    await mention({
      event: { text: '<@UBOT> /plan build the slice', ts: 'thread-idle-stop', user: 'U1', channel: 'C-test' },
      say,
    });

    await mention({
      event: { text: '<@UBOT> stop', ts: 'reply-idle-stop', thread_ts: 'thread-idle-stop', user: 'U1', channel: 'C-test' },
      say,
    });

    expect(conversationInstances.has('thread-idle-stop')).toBe(false);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Cancelled.', thread_ts: 'thread-idle-stop' }));
  });

  it('posts a stopped notice for PlannerAbortedError instead of an error reply', async () => {
    conversationFactory = () => createAlreadyAbortedConversation();
    const mention = getMentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'say-1' });

    await mention({
      event: { text: '<@UBOT> keep planning', ts: 'thread-aborted-error', user: 'U1', channel: 'C-test' },
      say,
    });

    const texts = say.mock.calls
      .map(([message]) => message?.text)
      .filter((text): text is string => typeof text === 'string');
    const stopNotices = texts.filter((text) => text.includes('Work the agent already executed was not rolled back.'));

    expect(stopNotices).toHaveLength(1);
    expect(stopNotices[0]).toContain('dropped 2 queued message(s)');
    expect(texts.some((text) => text.startsWith('Error:'))).toBe(false);
  });
});

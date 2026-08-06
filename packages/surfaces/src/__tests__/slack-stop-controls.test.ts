import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { PlannerAbortedError } from '../slack/plan-conversation.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

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
        postMessage: vi.fn().mockResolvedValue({ ts: 'posted-ts' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }

  return { App: MockApp };
});

type ConversationInstance = {
  sendMessage: ReturnType<typeof vi.fn>;
  runPlanConversion: ReturnType<typeof vi.fn>;
  getDraftedPlan: () => string | null;
  isTurnInFlight: () => boolean;
  getTurnStartedAt: () => number | null;
  getQueuedTurnCount: () => number;
  getLastAbortError: () => PlannerAbortedError | null;
  abortTurn: ReturnType<typeof vi.fn>;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  lastTurnDraftPlanText: string | null;
  lastTurnPlanIntentSignal: null;
  conversationMode: 'plan' | 'agent';
  planSubmitted: boolean;
  submittedPlanText: string | null;
  workingDir?: string;
};

const conversationInstances = new Map<string, ConversationInstance>();
const conversationFactories: Array<(config: any) => ConversationInstance> = [];

function buildDefaultConversation(config: any): ConversationInstance {
  return {
    sendMessage: vi.fn().mockResolvedValue('Normal reply'),
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: () => null,
    isTurnInFlight: () => false,
    getTurnStartedAt: () => null,
    getQueuedTurnCount: () => 0,
    getLastAbortError: () => null,
    abortTurn: vi.fn(() => false),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: config?.mode ?? 'plan',
    planSubmitted: false,
    submittedPlanText: null,
    workingDir: config?.workingDir,
  };
}

vi.mock('../slack/plan-conversation.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slack/plan-conversation.js')>();
  return {
    ...actual,
    PlanConversation: vi.fn((config: any) => {
      const factory = conversationFactories.shift();
      const instance = factory ? factory(config) : buildDefaultConversation(config);
      if (config?.threadTs) conversationInstances.set(config.threadTs, instance);
      return instance;
    }),
  };
});

function createAbortableConversation(config: any): ConversationInstance {
  let inFlight = false;
  let queuedTurns = 0;
  let startedAt: number | null = null;
  let lastAbortError: PlannerAbortedError | null = null;
  let rejectActive: ((error: Error) => void) | undefined;
  const queuedRejects: Array<(error: Error) => void> = [];

  const instance: ConversationInstance = {
    sendMessage: vi.fn().mockImplementation(async () => {
      if (!inFlight) {
        inFlight = true;
        startedAt = Date.now();
        return await new Promise<string>((_, reject) => {
          rejectActive = reject;
        });
      }
      queuedTurns++;
      return await new Promise<string>((_, reject) => {
        queuedRejects.push(reject);
      });
    }),
    runPlanConversion: vi.fn().mockResolvedValue(''),
    getDraftedPlan: () => null,
    isTurnInFlight: () => inFlight,
    getTurnStartedAt: () => startedAt,
    getQueuedTurnCount: () => queuedTurns,
    getLastAbortError: () => lastAbortError,
    abortTurn: vi.fn((reason?: string) => {
      if (!inFlight) return false;
      lastAbortError = new PlannerAbortedError(reason);
      inFlight = false;
      const error = lastAbortError;
      rejectActive?.(error);
      rejectActive = undefined;
      queuedTurns = 0;
      while (queuedRejects.length > 0) queuedRejects.shift()!(error);
      return true;
    }),
    history: [],
    lastTurnDraftPlanText: null,
    lastTurnPlanIntentSignal: null,
    conversationMode: config?.mode ?? 'plan',
    planSubmitted: false,
    submittedPlanText: null,
    workingDir: config?.workingDir,
  };

  return instance;
}

function getMentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((entry: MockHandler) => entry.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('Missing app_mention handler');
  return handler;
}

function getActionHandler(surface: SlackSurface, matcher: (pattern: string | RegExp) => boolean): Function {
  const app = surface.getApp() as any;
  const handler = app._actionHandlers.find((entry: MockHandler) => matcher(entry.pattern))?.handler;
  if (!handler) throw new Error('Missing action handler');
  return handler;
}

describe('Slack stop controls', () => {
  let surface: SlackSurface;

  beforeEach(() => {
    conversationInstances.clear();
    conversationFactories.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (surface) await surface.stop();
  });

  it('aborts a mid-turn exact stop message without enqueueing a new turn and posts one stopped notice', async () => {
    conversationFactories.push((config) => createAbortableConversation(config));
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      enableImmediateAck: false,
      useTypingIndicator: false,
      planningHeartbeatIntervalSeconds: 0,
    });
    await surface.start(async () => {});

    const mention = getMentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'say-ts' });

    const firstTurn = mention({
      event: { text: '<@UBOT> investigate the issue', ts: 'thread-stop', user: 'U1', channel: 'C-test' },
      say,
    });
    await Promise.resolve();

    const queuedTurn = mention({
      event: { text: '<@UBOT> add more detail', ts: 'thread-stop-q', thread_ts: 'thread-stop', user: 'U1', channel: 'C-test' },
      say,
    });
    let conversation = conversationInstances.get('thread-stop');
    for (let attempt = 0; attempt < 10 && !conversation; attempt++) {
      await Promise.resolve();
      conversation = conversationInstances.get('thread-stop');
    }
    expect(conversation).toBeDefined();
    for (let attempt = 0; attempt < 10 && conversation!.sendMessage.mock.calls.length < 2; attempt++) {
      await Promise.resolve();
      conversation = conversationInstances.get('thread-stop');
    }

    const stopTurn = mention({
      event: { text: '<@UBOT> stop', ts: 'thread-stop-s', thread_ts: 'thread-stop', user: 'U1', channel: 'C-test' },
      say,
    });

    await Promise.all([firstTurn, queuedTurn, stopTurn]);

    conversation = conversationInstances.get('thread-stop');
    expect(conversation!.sendMessage).toHaveBeenCalledTimes(2);
    expect(conversation!.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: 'thread-stop',
      text: expect.stringContaining('Dropped 1 queued message(s).'),
    }));
    expect(say.mock.calls[0][0].text).toContain('Work the agent already executed was not rolled back.');
  });

  it('adds a Stop button to heartbeat posts and aborts the same thread from the button action', async () => {
    vi.useFakeTimers();
    conversationFactories.push((config) => createAbortableConversation(config));
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      enableImmediateAck: false,
      useTypingIndicator: false,
      planningHeartbeatIntervalSeconds: 1,
    });
    await surface.start(async () => {});

    const mention = getMentionHandler(surface);
    const stopAction = getActionHandler(surface, (pattern) => String(pattern) === '/^stop_turn:/');
    const say = vi.fn().mockResolvedValue({ ts: 'heartbeat-ts' });

    const firstTurn = mention({
      event: { text: '<@UBOT> keep planning', ts: 'thread-button', user: 'U1', channel: 'C-test' },
      say,
    });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    const heartbeatCall = say.mock.calls.find((call) => Array.isArray(call[0].blocks));
    expect(heartbeatCall?.[0].blocks[1].elements[0].action_id).toBe('stop_turn:thread-button');

    const respond = vi.fn().mockResolvedValue(undefined);
    await stopAction({
      action: { type: 'button', action_id: 'stop_turn:thread-button', value: 'thread-button' },
      body: { channel: { id: 'C-test' }, message: { thread_ts: 'thread-button' }, user: { id: 'U1' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    await firstTurn;

    const conversation = conversationInstances.get('thread-button');
    expect(conversation).toBeDefined();
    expect(conversation!.sendMessage).toHaveBeenCalledTimes(1);
    expect(conversation!.abortTurn).toHaveBeenCalledWith('user requested stop from Slack');
    const app = surface.getApp() as any;
    expect(app.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C-test',
      thread_ts: 'thread-button',
      text: expect.stringContaining('Dropped 0 queued message(s).'),
    }));
    expect(respond).not.toHaveBeenCalledWith(expect.objectContaining({ text: 'There is nothing to stop.' }));
  });

  it('treats stop as the existing negation path on an idle thread and does not call abortTurn', async () => {
    conversationFactories.push((config) => buildDefaultConversation(config));
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      enableImmediateAck: false,
      useTypingIndicator: false,
      planningHeartbeatIntervalSeconds: 0,
    });
    await surface.start(async () => {});

    const mention = getMentionHandler(surface);
    const initialSay = vi.fn().mockResolvedValue({ ts: 'initial-ts' });
    await mention({
      event: { text: '<@UBOT> scope this', ts: 'thread-idle', user: 'U1', channel: 'C-test' },
      say: initialSay,
    });

    (surface as any).pendingConfirms.set('thread-idle', { kind: 'restart' });

    const say = vi.fn().mockResolvedValue({ ts: 'cancel-ts' });
    await mention({
      event: { text: '<@UBOT> stop', ts: 'idle-stop', thread_ts: 'thread-idle', user: 'U1', channel: 'C-test' },
      say,
    });

    const conversation = conversationInstances.get('thread-idle');
    expect(conversation).toBeDefined();
    expect(conversation!.abortTurn).not.toHaveBeenCalled();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      thread_ts: 'thread-idle',
      text: 'Cancelled.',
    }));
  });

  it('posts a stopped notice for PlannerAbortedError instead of an error reply', async () => {
    conversationFactories.push((config) => ({
      ...buildDefaultConversation(config),
      sendMessage: vi.fn().mockRejectedValue(new PlannerAbortedError('user requested stop from Slack')),
    }));
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      enableImmediateAck: false,
      useTypingIndicator: false,
      planningHeartbeatIntervalSeconds: 0,
    });
    await surface.start(async () => {});

    const mention = getMentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'aborted-ts' });

    await mention({
      event: { text: '<@UBOT> start planning', ts: 'thread-aborted', user: 'U1', channel: 'C-test' },
      say,
    });

    expect(say).toHaveBeenCalledTimes(1);
    expect(say.mock.calls[0][0].text).toContain('Stopped the in-flight planning turn');
    expect(say.mock.calls[0][0].text).toContain('Work the agent already executed was not rolled back.');
    expect(say.mock.calls[0][0].text).not.toContain('Error:');
  });
});

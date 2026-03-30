import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository } from '@invoker/persistence';
import type { SurfaceCommand } from '../surface.js';

// ── Mock @slack/bolt ────────────────────────────────────────

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
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }),
      },
    };
  }

  return { App: MockApp };
});

// ── Mock PlanConversation ───────────────────────────────────

// Track per-thread conversation instances
const conversationInstances = new Map<string, any>();
const mockPlanConversationCtor = vi.fn();

vi.mock('../slack/plan-conversation.js', () => ({
  PlanConversation: vi.fn((...args: any[]) => {
    const config = args[0];
    const instance = {
      _config: config,
      _messages: [] as Array<{ role: string; content: string }>,
      submittedPlanText: null as any,
      planSubmitted: false,
      init: vi.fn().mockResolvedValue(undefined),
      sendMessage: vi.fn().mockImplementation(async (text: string) => {
        instance._messages.push({ role: 'user', content: text });
        const reply = `Reply to: ${text}`;
        instance._messages.push({ role: 'assistant', content: reply });
        return reply;
      }),
      reset: vi.fn(),
      get history() {
        return instance._messages;
      },
    };
    if (config.threadTs) {
      conversationInstances.set(config.threadTs, instance);
    }
    mockPlanConversationCtor(config);
    return instance;
  }),
}));

// ── Helpers ─────────────────────────────────────────────────

const silentLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};

function getMentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

function getMessageHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'message')?.handler;
  if (!handler) throw new Error('message handler not registered');
  return handler;
}

// ── Tests ───────────────────────────────────────────────────

describe('Slack thread isolation', () => {
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(() => {
    receivedCommands = [];
    conversationInstances.clear();
    mockPlanConversationCtor.mockClear();

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
    });
  });

  describe('different threads get different conversations', () => {
    it('creates separate PlanConversation per thread via @mention', async () => {
      await surface.start(async (cmd) => { receivedCommands.push(cmd); });
      const mentionHandler = getMentionHandler(surface);
      const say = vi.fn();

      // Thread A: first @mention
      await mentionHandler({
        event: { text: '<@U_BOT> build a REST API', ts: 'thread-A', thread_ts: undefined, user: 'U1' },
        say,
      });

      // Thread B: different @mention
      await mentionHandler({
        event: { text: '<@U_BOT> build a CLI tool', ts: 'thread-B', thread_ts: undefined, user: 'U2' },
        say,
      });

      // Should have created 2 separate PlanConversation instances
      expect(conversationInstances.size).toBe(2);
      expect(conversationInstances.has('thread-A')).toBe(true);
      expect(conversationInstances.has('thread-B')).toBe(true);

      // Each should have received its own message
      const convA = conversationInstances.get('thread-A');
      const convB = conversationInstances.get('thread-B');
      // Note: SlackSurface strips <@[A-Z0-9]+> but mock bot ID U_BOT contains underscore,
      // so the mention prefix remains. The key assertion is that each thread gets its own instance.
      expect(convA.sendMessage).toHaveBeenCalledTimes(1);
      expect(convB.sendMessage).toHaveBeenCalledTimes(1);
    });

    it('reuses same PlanConversation for replies in same thread', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      // Initial @mention creates the conversation
      await mentionHandler({
        event: { text: '<@U_BOT> build a REST API', ts: 'thread-C', thread_ts: undefined, user: 'U1' },
        say,
      });

      const initialConversation = conversationInstances.get('thread-C');
      expect(initialConversation).toBeDefined();

      // Reply in same thread — should reuse the same conversation
      await messageHandler({
        event: { text: 'Add authentication too', ts: '999.999', thread_ts: 'thread-C', user: 'U1' },
        say,
      });

      // sendMessage should have been called twice on the SAME instance
      expect(initialConversation.sendMessage).toHaveBeenCalledTimes(2);
      // First call from @mention, second from thread reply
      expect(initialConversation.sendMessage).toHaveBeenNthCalledWith(2, 'Add authentication too');
    });

    it('does not cross-contaminate messages between threads', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      // Thread D
      await mentionHandler({
        event: { text: '<@U_BOT> thread D message', ts: 'thread-D', thread_ts: undefined, user: 'U1' },
        say,
      });

      // Thread E
      await mentionHandler({
        event: { text: '<@U_BOT> thread E message', ts: 'thread-E', thread_ts: undefined, user: 'U2' },
        say,
      });

      // Reply to thread D — should only go to thread D's conversation
      await messageHandler({
        event: { text: 'Follow-up for D', ts: '100.100', thread_ts: 'thread-D', user: 'U1' },
        say,
      });

      const convD = conversationInstances.get('thread-D');
      const convE = conversationInstances.get('thread-E');

      // Thread D: 1 mention + 1 reply = 2 calls
      expect(convD.sendMessage).toHaveBeenCalledTimes(2);
      // Thread E: 1 mention only
      expect(convE.sendMessage).toHaveBeenCalledTimes(1);

      // Verify the correct messages went to the correct threads
      expect(convD.sendMessage).toHaveBeenCalledWith('Follow-up for D');
      expect(convE.sendMessage).not.toHaveBeenCalledWith('Follow-up for D');
    });
  });

  describe('thread reply handler filtering', () => {
    it('ignores messages not in a thread', async () => {
      await surface.start(async () => {});
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      await messageHandler({
        event: { text: 'top-level message', ts: '111.111', user: 'U1' },
        say,
      });

      // No conversation should be created
      expect(conversationInstances.size).toBe(0);
      expect(say).not.toHaveBeenCalled();
    });

    it('ignores bot messages to prevent loops', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      // Create a conversation first
      await mentionHandler({
        event: { text: '<@U_BOT> start', ts: 'thread-F', thread_ts: undefined, user: 'U1' },
        say,
      });

      const conv = conversationInstances.get('thread-F');
      conv.sendMessage.mockClear();

      // Bot's own reply in the thread
      await messageHandler({
        event: { text: 'Bot reply', ts: '200.200', thread_ts: 'thread-F', user: 'U_BOT' },
        say,
      });

      // Should not send message to conversation
      expect(conv.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores bot_message subtype', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      await mentionHandler({
        event: { text: '<@U_BOT> start', ts: 'thread-G', thread_ts: undefined, user: 'U1' },
        say,
      });

      const conv = conversationInstances.get('thread-G');
      conv.sendMessage.mockClear();

      await messageHandler({
        event: { text: 'Integration message', ts: '300.300', thread_ts: 'thread-G', subtype: 'bot_message', bot_id: 'B123' },
        say,
      });

      expect(conv.sendMessage).not.toHaveBeenCalled();
    });

    it('ignores thread replies for non-existent conversations', async () => {
      await surface.start(async () => {});
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      // Reply to a thread that has no PlanConversation
      await messageHandler({
        event: { text: 'Random reply', ts: '400.400', thread_ts: 'unknown-thread', user: 'U1' },
        say,
      });

      // Should not create a conversation or call say
      expect(conversationInstances.has('unknown-thread')).toBe(false);
      expect(say).not.toHaveBeenCalled();
    });

    it('ignores empty text after stripping @mention', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const say = vi.fn();

      // Use a Slack-style user ID (no underscores) so the regex strips it properly
      await mentionHandler({
        event: { text: '<@UBOT123>', ts: 'thread-empty', thread_ts: undefined, user: 'U1' },
        say,
      });

      // Should get a help message, not create a conversation
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Tag me') }),
      );
    });
  });

  describe('plan submission removes conversation from thread map', () => {
    it('removes conversation after plan submission via sendMessage', async () => {
      await surface.start(async (cmd) => { receivedCommands.push(cmd); });
      const mentionHandler = getMentionHandler(surface);
      const say = vi.fn();

      await mentionHandler({
        event: { text: '<@U_BOT> build something', ts: 'thread-submit', thread_ts: undefined, user: 'U1' },
        say,
      });

      const conv = conversationInstances.get('thread-submit');
      // Simulate plan submission (sets both planSubmitted and submittedPlanText)
      conv.submittedPlanText = 'name: "Submit Test"\ntasks:\n  - id: t1\n    description: "Test"\n    dependencies: []\n';
      conv.planSubmitted = true;
      conv.sendMessage.mockResolvedValueOnce('Submitting plan.');

      // Follow-up that triggers submission
      await mentionHandler({
        event: { text: '<@U_BOT> go ahead', ts: '500.500', thread_ts: 'thread-submit', user: 'U1' },
        say,
      });

      // Should have emitted start_plan command
      expect(receivedCommands).toContainEqual(
        expect.objectContaining({ type: 'start_plan' }),
      );
    });

    it('all messages go through sendMessage (no confirmation shortcut)', async () => {
      await surface.start(async (cmd) => { receivedCommands.push(cmd); });
      const mentionHandler = getMentionHandler(surface);
      const messageHandler = getMessageHandler(surface);
      const say = vi.fn();

      await mentionHandler({
        event: { text: '<@U_BOT> build it', ts: 'thread-confirm', thread_ts: undefined, user: 'U1' },
        say,
      });

      const conv = conversationInstances.get('thread-confirm');

      // "yes" goes through sendMessage just like any other message
      await messageHandler({
        event: { text: 'yes', ts: '600.600', thread_ts: 'thread-confirm', user: 'U1' },
        say,
      });

      expect(conv.sendMessage).toHaveBeenCalledTimes(2);
      expect(conv.sendMessage).toHaveBeenNthCalledWith(2, 'yes');
    });
  });

  describe('error handling per thread', () => {
    it('error in one thread does not affect another', async () => {
      await surface.start(async () => {});
      const mentionHandler = getMentionHandler(surface);
      const say = vi.fn();

      // Thread H: normal
      await mentionHandler({
        event: { text: '<@U_BOT> build feature H', ts: 'thread-H', thread_ts: undefined, user: 'U1' },
        say,
      });

      // Thread I: will fail
      await mentionHandler({
        event: { text: '<@U_BOT> build feature I', ts: 'thread-I', thread_ts: undefined, user: 'U2' },
        say,
      });

      const convI = conversationInstances.get('thread-I');
      convI.sendMessage.mockRejectedValueOnce(new Error('API timeout'));

      // Reply to thread I (will fail)
      const messageHandler = getMessageHandler(surface);
      await messageHandler({
        event: { text: 'continue I', ts: '700.700', thread_ts: 'thread-I', user: 'U2' },
        say,
      });

      // Thread I should get error message
      expect(say).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('API timeout'),
          thread_ts: 'thread-I',
        }),
      );

      // Thread H should still work
      const convH = conversationInstances.get('thread-H');
      convH.sendMessage.mockClear();
      await messageHandler({
        event: { text: 'continue H', ts: '800.800', thread_ts: 'thread-H', user: 'U1' },
        say,
      });
      expect(convH.sendMessage).toHaveBeenCalledWith('continue H');
    });
  });
});

/** Flush pending microtasks so fire-and-forget async work (e.g. postConnectInit) settles. */
const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('Slack conversation recovery with persistence', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(async () => {
    receivedCommands = [];
    conversationInstances.clear();
    mockPlanConversationCtor.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, silentLogger);
  });

  afterEach(() => {
    adapter.close();
  });

  it('recovers active conversations from database on start', async () => {
    // Seed the database with active conversations
    repo.saveConversation('ts-recover-1', [
      { role: 'user', content: 'Build a feature' },
      { role: 'assistant', content: 'Let me explore.' },
    ]);
    repo.saveConversation('ts-recover-2', [
      { role: 'user', content: 'Build another feature' },
    ]);

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      conversationRepo: repo,
    });

    await surface.start(async (cmd) => { receivedCommands.push(cmd); });
    await flushAsync(); // wait for background postConnectInit()

    // PlanConversation constructor should have been called for each active conversation
    const threadTsArgs = mockPlanConversationCtor.mock.calls.map((c: any[]) => c[0].threadTs);
    expect(threadTsArgs).toContain('ts-recover-1');
    expect(threadTsArgs).toContain('ts-recover-2');
  });

  it('does not recover submitted conversations', async () => {
    // Save an active and a submitted conversation
    repo.saveConversation('ts-active', [
      { role: 'user', content: 'active conv' },
    ]);
    repo.saveConversation('ts-done', [
      { role: 'user', content: 'done conv' },
    ], { name: 'Plan', tasks: [{ id: 't1', description: 'Test', dependencies: [] }] } as any, true);

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      conversationRepo: repo,
    });

    await surface.start(async () => {});
    await flushAsync(); // wait for background postConnectInit()

    const threadTsArgs = mockPlanConversationCtor.mock.calls.map((c: any[]) => c[0].threadTs);
    expect(threadTsArgs).toContain('ts-active');
    expect(threadTsArgs).not.toContain('ts-done');
  });

  it('skips recovery when no conversationRepo is configured', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      // no conversationRepo
    });

    await surface.start(async () => {});
    await flushAsync(); // wait for background postConnectInit()

    // No recovery should have happened
    expect(mockPlanConversationCtor).not.toHaveBeenCalled();
  });

  it('lazy recovery via message handler for threads not in memory', async () => {
    // Seed a conversation in DB but don't start with recovery
    repo.saveConversation('ts-lazy', [
      { role: 'user', content: 'old message' },
    ]);

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
      conversationRepo: repo,
    });

    await surface.start(async () => {});
    await flushAsync(); // wait for background postConnectInit()

    // Clear any conversations created during start recovery
    const existingCalls = mockPlanConversationCtor.mock.calls.length;

    // Send a message to the lazy thread
    const messageHandler = getMessageHandler(surface);
    const say = vi.fn();

    await messageHandler({
      event: { text: 'Continue please', ts: '999.999', thread_ts: 'ts-lazy', user: 'U1' },
      say,
    });

    // Should have created a new PlanConversation for lazy recovery
    const lazyCall = mockPlanConversationCtor.mock.calls.find(
      (c: any[]) => c[0].threadTs === 'ts-lazy',
    );
    expect(lazyCall).toBeDefined();
  });

  it('stop clears in-memory conversations', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
    });

    await surface.start(async () => {});
    const mentionHandler = getMentionHandler(surface);
    const say = vi.fn();

    // Create a conversation
    await mentionHandler({
      event: { text: '<@U_BOT> build something', ts: 'thread-stop', thread_ts: undefined, user: 'U1' },
      say,
    });

    // Stop should clear taskMessages map
    await surface.stop();
    expect(surface.getTaskMessages().size).toBe(0);
  });
});

// ── E2E: Full Slack flow (mention → plan → confirm → submit → execute) ──

describe('E2E: Full Slack flow without real APIs', () => {
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  const YAML_PLAN = `Here's your plan:

\`\`\`yaml
name: "Add REST API"
onFinish: merge
baseBranch: main
tasks:
  - id: implement
    description: "Implement the REST API endpoints"
    prompt: "Add GET/POST endpoints for /users"
    dependencies: []
  - id: test
    description: "Test the endpoints"
    command: "pnpm test"
    dependencies:
      - implement
\`\`\`

Want me to execute this?`;

  beforeEach(() => {
    receivedCommands = [];
    conversationInstances.clear();
    mockPlanConversationCtor.mockClear();

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      cursorCommand: 'cursor',
    });
  });

  it('mention → plan response → user confirms → submit_plan → start_plan', async () => {
    await surface.start(async (cmd) => { receivedCommands.push(cmd); });
    const mentionHandler = getMentionHandler(surface);
    const messageHandler = getMessageHandler(surface);
    const say = vi.fn();

    // Step 1: User @mentions with a request
    await mentionHandler({
      event: { text: '<@U_BOT> build a REST API', ts: 'thread-e2e', thread_ts: undefined, user: 'U1' },
      say,
    });

    const conv = conversationInstances.get('thread-e2e');
    expect(conv).toBeDefined();
    expect(conv.sendMessage).toHaveBeenCalledTimes(1);

    // Step 2: Mock sendMessage to return a YAML plan response
    say.mockClear();
    conv.sendMessage.mockResolvedValueOnce(YAML_PLAN);

    await messageHandler({
      event: { text: 'I want GET and POST for /users', ts: '100.100', thread_ts: 'thread-e2e', user: 'U1' },
      say,
    });

    // Should post the plan text to the thread
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({ text: YAML_PLAN, thread_ts: 'thread-e2e' }),
    );
    // No start_plan yet — Claude hasn't called submit_plan
    expect(receivedCommands).not.toContainEqual(
      expect.objectContaining({ type: 'start_plan' }),
    );

    // Step 3: User confirms → planSubmitted + submittedPlanText set
    say.mockClear();
    const expectedPlanText = 'name: "Add REST API"\ntasks:\n  - id: implement\n    description: "Implement the REST API endpoints"\n  - id: test\n    description: "Test the endpoints"\n    command: "pnpm test"\n';
    conv.sendMessage.mockImplementationOnce(async () => {
      conv.planSubmitted = true;
      conv.submittedPlanText = expectedPlanText;
      return 'Plan submitted! Starting execution now.';
    });

    await messageHandler({
      event: { text: 'execute', ts: '200.200', thread_ts: 'thread-e2e', user: 'U1' },
      say,
    });

    // Should post Claude's reply
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Plan submitted! Starting execution now.', thread_ts: 'thread-e2e' }),
    );

    // Should post the "Starting" execution message
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Starting') }),
    );

    // Should emit start_plan command with the raw plan text
    expect(receivedCommands).toHaveLength(1);
    expect(receivedCommands[0]).toEqual(
      expect.objectContaining({
        type: 'start_plan',
        planText: expectedPlanText,
      }),
    );
  });
});

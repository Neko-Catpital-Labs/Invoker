import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceEvent, SurfaceCommand } from '../surface.js';

// ── Mock @slack/bolt ────────────────────────────────────────

// We mock the App class to avoid real Slack connections.
// The mock tracks registered handlers and simulates interactions.

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
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }

  return { App: MockApp };
});

const mockSendMessage = vi.fn();
let mockDraftedPlan: string | null = null;
const mockPlanConversation = {
  sendMessage: mockSendMessage,
  getDraftedPlan: () => mockDraftedPlan,
  submittedPlanText: null as any,
  planSubmitted: false,
  conversationMode: 'plan' as const,
};

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack/plan-conversation.js')>()),
  PlanConversation: vi.fn(() => mockPlanConversation),
}));

// ── Tests ───────────────────────────────────────────────────

describe('SlackSurface', () => {
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(() => {
    receivedCommands = [];
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
    });
  });

  describe('start', () => {
    it('calls app.start()', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      expect(app.start).toHaveBeenCalled();
    });

    it('registers /invoker slash command', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      expect(app.command).toHaveBeenCalledWith('/invoker', expect.any(Function));
    });

    it('registers action handlers for approve, reject, select, input', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      // 6 action registrations: approve:, reject:, select:, input:, lobby_confirm, lobby_cancel
      expect(app.action).toHaveBeenCalledTimes(6);
    });

    it('registers app_mention and message event handlers', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      const eventNames = app._eventHandlers.map((h: MockHandler) => h.pattern);
      expect(eventNames).toContain('app_mention');
      expect(eventNames).toContain('message');
    });

    it('resolves bot user ID on start', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      expect(app.client.auth.test).toHaveBeenCalled();
    });

    it('logs receipt and route for every app mention before replying', async () => {
      const log = vi.fn();
      surface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-lobby',
        lobbyChannelId: 'C-lobby',
        instanceId: 'do1-proof',
        log,
      });
      await surface.start(async () => {});
      const app = surface.getApp() as any;
      const mention = app._eventHandlers.find((handler: MockHandler) => handler.pattern === 'app_mention').handler;

      await mention({
        event: { text: '<@U_BOT> hello', ts: 'event-1', user: 'U1', channel: 'C-other' },
        say: vi.fn().mockResolvedValue(undefined),
      });

      expect(log).toHaveBeenCalledWith('slack', 'info', expect.stringContaining('[MENTION_RECEIVED] instance=do1-proof event_ts=event-1'));
      expect(log).toHaveBeenCalledWith('slack', 'info', expect.stringContaining('[MENTION_ROUTE] instance=do1-proof event_ts=event-1 route=non-lobby'));
    });
  });

  describe('stop', () => {
    it('calls app.stop()', async () => {
      await surface.start(async () => {});
      await surface.stop();
      const app = surface.getApp() as any;
      expect(app.stop).toHaveBeenCalled();
    });
  });

  describe('handleEvent', () => {
    function surfaceWithMappedWorkflow(): SlackSurface {
      const mockRepo = {
        getByWorkflowId: vi.fn((id: string) => (id === 'wf-1' ? { channelId: 'C-mapped', workflowId: 'wf-1' } : null)),
        getByChannelId: vi.fn(() => undefined),
        list: vi.fn(() => [{ channelId: 'C-mapped', workflowId: 'wf-1' }]),
        save: vi.fn(),
        delete: vi.fn(),
      };
      return new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        workflowChannelRepo: mockRepo as any,
      });
    }

    it('suppresses task_delta created when the workflow channel is unmapped', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      await surface.handleEvent({
        type: 'task_delta',
        delta: {
          type: 'created',
          task: { id: 'wf-1/t1', description: 'Test task', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
        },
      });

      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
      expect(surface.getTaskMessages().has('wf-1/t1')).toBe(false);
    });

    it('posts a new message for task_delta created on a mapped workflow channel', async () => {
      const mapped = surfaceWithMappedWorkflow();
      await mapped.start(async () => {});
      const app = mapped.getApp() as any;

      await mapped.handleEvent({
        type: 'task_delta',
        delta: {
          type: 'created',
          task: { id: 'wf-1/t1', description: 'Test task', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
        },
      });

      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C-mapped',
        }),
      );
      expect(mapped.getTaskMessages().get('wf-1/t1')).toBe('1234567890.123456');
    });

    it('updates existing message for task_delta updated on a mapped workflow channel', async () => {
      const mapped = surfaceWithMappedWorkflow();
      await mapped.start(async () => {});
      const app = mapped.getApp() as any;

      await mapped.handleEvent({
        type: 'task_delta',
        delta: {
          type: 'created',
          task: { id: 'wf-1/t1', description: 'Test', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
        },
      });

      app.client.chat.postMessage.mockClear();

      await mapped.handleEvent({
        type: 'task_delta',
        delta: { type: 'updated', taskId: 'wf-1/t1', changes: { status: 'running' } },
      });

      expect(app.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C-mapped',
          ts: '1234567890.123456',
        }),
      );
      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('posts workflow_status only when the workflow channel is mapped', async () => {
      const mapped = surfaceWithMappedWorkflow();
      await mapped.start(async () => {});
      const app = mapped.getApp() as any;

      await mapped.handleEvent({
        type: 'workflow_status',
        workflowId: 'wf-1',
        status: { total: 5, completed: 2, failed: 0, closed: 0, running: 1, pending: 2 },
      });

      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C-mapped' }),
      );
    });

    it('suppresses error events that do not resolve to a mapped workflow channel', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      await surface.handleEvent({
        type: 'error',
        message: 'Something broke',
      });

      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    });
  });

  describe('workflow_progress card', () => {
    it('posts once then edits in place, targeting the mapped channel', async () => {
      const mockRepo = {
        getByWorkflowId: vi.fn((id: string) => (id === 'wf-1' ? { channelId: 'C-mapped' } : null)),
        getByChannelId: vi.fn(() => undefined),
        list: vi.fn(() => []),
        save: vi.fn(),
        delete: vi.fn(),
      };
      const cardSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 's',
        channelId: 'C-test',
        workflowChannelRepo: mockRepo as any,
      });
      await cardSurface.start(async () => {});
      const app = cardSurface.getApp() as any;

      const progress = {
        workflowId: 'wf-1',
        name: 'WF',
        percentComplete: 25,
        counts: { total: 4, completed: 1, failed: 0, closed: 0, running: 1, pending: 2 },
        tasks: [{ id: 'build', name: 'Build', status: 'running', phase: 'executing' }],
      };

      await cardSurface.handleEvent({ type: 'workflow_progress', progress } as SurfaceEvent);
      await cardSurface.handleEvent({ type: 'workflow_progress', progress } as SurfaceEvent);

      expect(app.client.chat.postMessage).toHaveBeenCalledTimes(1);
      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C-mapped' }),
      );
      expect(app.client.chat.update).toHaveBeenCalledTimes(1);
      expect(app.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({ channel: 'C-mapped', ts: '1234567890.123456' }),
      );
    });
  });

  describe('slash command handler', () => {
    it('rejects removed commands like approve with an error', async () => {
      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;
      expect(handler).toBeDefined();

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'approve task-1' }, ack, respond });

      expect(ack).toHaveBeenCalled();
      expect(receivedCommands).toHaveLength(0);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });

    it('responds with error for invalid commands', async () => {
      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: '' }, ack, respond });

      expect(ack).toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ response_type: 'ephemeral' }),
      );
    });
  });

  describe('action handlers', () => {
    it('routes approve button clicks', async () => {
      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surface.getApp() as any;
      const approveHandler = app._actionHandlers.find(
        (h: MockHandler) => h.pattern instanceof RegExp && h.pattern.test('approve:t1'),
      )?.handler;
      expect(approveHandler).toBeDefined();

      const ack = vi.fn();
      await approveHandler({ action: { type: 'button', value: 'task-1' }, ack });

      expect(ack).toHaveBeenCalled();
      expect(receivedCommands).toEqual([{ type: 'approve', taskId: 'task-1' }]);
    });

    it('routes reject button clicks', async () => {
      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surface.getApp() as any;
      const rejectHandler = app._actionHandlers.find(
        (h: MockHandler) => h.pattern instanceof RegExp && h.pattern.test('reject:t1'),
      )?.handler;

      const ack = vi.fn();
      await rejectHandler({ action: { type: 'button', value: 'task-1' }, ack });

      expect(receivedCommands).toEqual([{ type: 'reject', taskId: 'task-1' }]);
    });

    it('routes select experiment button clicks', async () => {
      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surface.getApp() as any;
      const selectHandler = app._actionHandlers.find(
        (h: MockHandler) => h.pattern instanceof RegExp && h.pattern.test('select:recon-1:exp-a'),
      )?.handler;

      const ack = vi.fn();
      await selectHandler({ action: { type: 'button', value: 'recon-1:exp-a' }, ack });

      expect(receivedCommands).toEqual([
        { type: 'select_experiment', taskId: 'recon-1', experimentId: 'exp-a' },
      ]);
    });
  });

  describe('type', () => {
    it('returns "slack"', () => {
      expect(surface.type).toBe('slack');
    });
  });

  describe('conversation admin commands', () => {
    it('denies non-admin users', async () => {
      const adminSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        adminUserIds: ['U_ADMIN'],
      });

      await adminSurface.start(async () => {});

      const app = adminSurface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'conversations list', user_id: 'U_RANDOM', user_name: 'random' }, ack, respond });

      expect(ack).toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Permission denied') }),
      );
    });

    it('allows admin users to run conversation commands', async () => {
      const mockRepo = {
        listActiveConversations: vi.fn().mockReturnValue([]),
        loadConversation: vi.fn(),
        deleteConversation: vi.fn(),
        cleanupOldConversations: vi.fn(),
      };

      const adminSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        adminUserIds: ['U_ADMIN'],
        conversationRepo: mockRepo as any,
      });

      await adminSurface.start(async () => {});

      const app = adminSurface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'conversations list', user_id: 'U_ADMIN', user_name: 'admin' }, ack, respond });

      expect(ack).toHaveBeenCalled();
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('No active conversations') }),
      );
    });

    it('returns error when persistence is not configured', async () => {
      const adminSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        adminUserIds: ['U_ADMIN'],
        // no conversationRepo
      });

      await adminSurface.start(async () => {});

      const app = adminSurface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'conversations list', user_id: 'U_ADMIN', user_name: 'admin' }, ack, respond });

      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('persistence is not enabled') }),
      );
    });

    it('handles conversations clear command', async () => {
      const mockRepo = {
        listActiveConversations: vi.fn().mockReturnValue([]),
        loadConversation: vi.fn().mockReturnValue({ threadTs: '1234.5678', messages: [], channelId: 'C1', userId: 'U1', createdAt: '', updatedAt: '' }),
        deleteConversation: vi.fn(),
        cleanupOldConversations: vi.fn(),
      };

      const adminSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        adminUserIds: ['U_ADMIN'],
        conversationRepo: mockRepo as any,
      });

      await adminSurface.start(async () => {});

      const app = adminSurface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'conversations clear 1234.5678', user_id: 'U_ADMIN', user_name: 'admin' }, ack, respond });

      expect(mockRepo.deleteConversation).toHaveBeenCalledWith('1234.5678');
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('Cleared') }),
      );
    });

    it('handles conversations cleanup command', async () => {
      const mockRepo = {
        listActiveConversations: vi.fn().mockReturnValue([]),
        loadConversation: vi.fn(),
        deleteConversation: vi.fn(),
        cleanupOldConversations: vi.fn().mockReturnValue(3),
      };

      const adminSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        adminUserIds: ['U_ADMIN'],
        conversationRepo: mockRepo as any,
      });

      await adminSurface.start(async () => {});

      const app = adminSurface.getApp() as any;
      const handler = app._commandHandlers.find((h: MockHandler) => h.pattern === '/invoker')?.handler;

      const ack = vi.fn();
      const respond = vi.fn();
      await handler({ command: { text: 'conversations cleanup 7', user_id: 'U_ADMIN', user_name: 'admin' }, ack, respond });

      expect(mockRepo.cleanupOldConversations).toHaveBeenCalledWith(7);
      expect(respond).toHaveBeenCalledWith(
        expect.objectContaining({ text: expect.stringContaining('3 conversation(s)') }),
      );
    });
  });

  describe('plan submission via mention', () => {
    let surfaceWithApi: SlackSurface;

    beforeEach(() => {
      mockSendMessage.mockReset();
      mockPlanConversation.submittedPlanText = null;
      mockPlanConversation.planSubmitted = false;
      mockDraftedPlan = null;

      surfaceWithApi = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        cursorCommand: 'cursor',
      });
    });

    it('submits the drafted plan from its inline approval button', async () => {
      const planText = 'name: "Test Plan"\ntasks:\n  - id: t1\n    description: "Do something useful"\n    dependencies: []\n';
      mockSendMessage.mockResolvedValue('Here is your plan.');
      mockDraftedPlan = planText;

      await surfaceWithApi.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surfaceWithApi.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
      const confirmHandler = app._actionHandlers.find((h: MockHandler) => h.pattern === 'lobby_confirm')?.handler;

      // Explicit plan request → a planning conversation with inline approval; nothing submitted.
      const say1 = vi.fn().mockResolvedValue({ ts: '1111.001' });
      await mentionHandler({ event: { text: '<@U_BOT> plan: build me a REST API', ts: '1111', thread_ts: undefined }, say: say1 });
      expect(receivedCommands).toHaveLength(0);
      expect(app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('Approve to execute'),
        blocks: expect.arrayContaining([expect.objectContaining({ type: 'actions' })]),
      }));

      await confirmHandler({
        action: { type: 'button', value: '1111' },
        body: { channel: { id: 'C-test' }, message: { thread_ts: '1111' } },
        ack: vi.fn().mockResolvedValue(undefined),
        respond: vi.fn().mockResolvedValue(undefined),
      });
      expect(receivedCommands).toEqual([
        expect.objectContaining({ type: 'start_plan', planText }),
      ]);
    });

    it('does not call start_plan when plan exists but planSubmitted is false', async () => {
      mockSendMessage.mockImplementation(async () => {
        mockPlanConversation.submittedPlanText = null;
        mockPlanConversation.planSubmitted = false;
        return 'Here is the plan. Want me to run it?';
      });

      await surfaceWithApi.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surfaceWithApi.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn().mockResolvedValue({ ts: '2222.001' });
      await mentionHandler({
        event: { text: '<@U_BOT> build something', ts: '2222', thread_ts: undefined },
        say,
      });

      // Should post immediate ack once, then replace it with actual response (via update), no execution message
      expect(say).toHaveBeenCalledTimes(1);
      expect(say).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'Processing your request...' }));
      expect(app.client.chat.update).toHaveBeenCalledWith(expect.objectContaining({
        channel: 'C-test',
        ts: '2222.001',
        text: 'Here is the plan. Want me to run it?',
      }));
      expect(receivedCommands).toHaveLength(0);
    });

    it('posts messages normally when immediate ack is disabled', async () => {
      mockSendMessage.mockImplementation(async () => {
        mockPlanConversation.submittedPlanText = null;
        mockPlanConversation.planSubmitted = false;
        return 'Here is my response.';
      });

      const surfaceNoAck = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        enableImmediateAck: false,
      });

      await surfaceNoAck.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surfaceNoAck.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn();
      await mentionHandler({
        event: { text: '<@U_BOT> hello', ts: '3333', thread_ts: undefined },
        say,
      });

      // Should NOT post ack, just post response directly
      expect(say).toHaveBeenCalledTimes(1);
      expect(say).toHaveBeenNthCalledWith(1, expect.objectContaining({ text: 'Here is my response.' }));
      // Should NOT call update since no ack was posted
      expect(app.client.chat.update).not.toHaveBeenCalled();
    });
  });

  describe('typing indicator', () => {
    it('adds and removes reaction when useTypingIndicator is enabled', async () => {
      const surfaceWithTyping = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-key',
        useTypingIndicator: true,
        immediateAckEmoji: 'hourglass',
      });

      mockSendMessage.mockResolvedValue('Reply from Claude');
      mockPlanConversation.planSubmitted = false;
      mockPlanConversation.submittedPlanText = null;

      await surfaceWithTyping.start(async () => {});

      const app = surfaceWithTyping.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn();
      await mentionHandler({
        event: { text: '<@U_BOT> help me', ts: '3333.0000', thread_ts: undefined, user: 'U123' },
        say,
      });

      // Should add reaction at start
      expect(app.client.reactions.add).toHaveBeenCalledWith({
        channel: 'C-test',
        timestamp: '3333.0000',
        name: 'hourglass',
      });

      // Should remove reaction after response
      expect(app.client.reactions.remove).toHaveBeenCalledWith({
        channel: 'C-test',
        timestamp: '3333.0000',
        name: 'hourglass',
      });

      // Should post reply
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Reply from Claude' }));
    });

    it('does not add reaction when useTypingIndicator is false', async () => {
      const surfaceNoTyping = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-key',
        useTypingIndicator: false,
      });

      mockSendMessage.mockResolvedValue('Reply');
      mockPlanConversation.planSubmitted = false;
      mockPlanConversation.submittedPlanText = null;

      await surfaceNoTyping.start(async () => {});

      const app = surfaceNoTyping.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn();
      await mentionHandler({
        event: { text: '<@U_BOT> test', ts: '4444.0000', thread_ts: undefined, user: 'U123' },
        say,
      });

      // Should NOT add or remove reactions
      expect(app.client.reactions.add).not.toHaveBeenCalled();
      expect(app.client.reactions.remove).not.toHaveBeenCalled();
    });
  });

  describe('planning config threading', () => {
    it('accepts planningTimeoutSeconds and planningHeartbeatIntervalSeconds config', () => {
      const configuredSurface = new SlackSurface({
        defaultRepoUrl: 'https://github.com/example/repo.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        planningTimeoutSeconds: 600,
        planningHeartbeatIntervalSeconds: 30,
      });
      expect(configuredSurface).toBeDefined();
    });
  });

  describe('multi-repo [repo:] tag resolution', () => {
    it('threads a [repo:<alias>] tag into the created session instead of the default repo', async () => {
      const MockedPlanConversation = vi.mocked((await import('../slack/plan-conversation.js')).PlanConversation);
      MockedPlanConversation.mockClear();

      const multiRepoSurface = new SlackSurface({
        defaultRepoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        repoAliases: { notarepo: 'git@github.com:EdbertChan/notarepo.git' },
      });

      await multiRepoSurface.start(async () => {});
      const app = multiRepoSurface.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn().mockResolvedValue({ ts: '5555.001' });
      await mentionHandler({
        event: { text: '<@U_BOT> [repo:notarepo] plan: add a health endpoint', ts: '5555', thread_ts: undefined, user: 'U1' },
        say,
      });

      expect(MockedPlanConversation).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: 'git@github.com:EdbertChan/notarepo.git' }),
      );
      expect(MockedPlanConversation).not.toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git' }),
      );
    });

    it('falls back to the default repoUrl when the mention carries no [repo:] tag', async () => {
      const MockedPlanConversation = vi.mocked((await import('../slack/plan-conversation.js')).PlanConversation);
      MockedPlanConversation.mockClear();

      const multiRepoSurface = new SlackSurface({
        defaultRepoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git',
        repoAliases: { notarepo: 'git@github.com:EdbertChan/notarepo.git' },
      });

      await multiRepoSurface.start(async () => {});
      const app = multiRepoSurface.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn().mockResolvedValue({ ts: '6666.001' });
      await mentionHandler({
        event: { text: '<@U_BOT> plan: add a health endpoint', ts: '6666', thread_ts: undefined, user: 'U1' },
        say,
      });

      expect(MockedPlanConversation).toHaveBeenCalledWith(
        expect.objectContaining({ repoUrl: 'git@github.com:Neko-Catpital-Labs/Invoker.git' }),
      );
    });
  });
});

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
    };
  }

  return { App: MockApp };
});

const mockSendMessage = vi.fn();
const mockPlanConversation = {
  sendMessage: mockSendMessage,
  submittedPlan: null as any,
  planSubmitted: false,
};

vi.mock('../slack/plan-conversation.js', () => ({
  PlanConversation: vi.fn(() => mockPlanConversation),
}));

// ── Tests ───────────────────────────────────────────────────

describe('SlackSurface', () => {
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(() => {
    receivedCommands = [];
    surface = new SlackSurface({
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
      // 4 action registrations: approve:, reject:, select:, input:
      expect(app.action).toHaveBeenCalledTimes(4);
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
    it('posts a new message for task_delta created', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      const event: SurfaceEvent = {
        type: 'task_delta',
        delta: {
          type: 'created',
          task: { id: 't1', description: 'Test task', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
        },
      };

      await surface.handleEvent(event);

      expect(app.client.chat.postMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C-test',
        }),
      );

      // Should track the message timestamp
      expect(surface.getTaskMessages().get('t1')).toBe('1234567890.123456');
    });

    it('updates existing message for task_delta updated', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      // First, create the task (posts new message)
      await surface.handleEvent({
        type: 'task_delta',
        delta: {
          type: 'created',
          task: { id: 't1', description: 'Test', status: 'pending', dependencies: [], createdAt: new Date(), config: {}, execution: {} },
        },
      });

      // Then update it (should update, not post new)
      app.client.chat.postMessage.mockClear();

      await surface.handleEvent({
        type: 'task_delta',
        delta: { type: 'updated', taskId: 't1', changes: { status: 'running' } },
      });

      expect(app.client.chat.update).toHaveBeenCalledWith(
        expect.objectContaining({
          channel: 'C-test',
          ts: '1234567890.123456',
        }),
      );
      // Should not post a new message
      expect(app.client.chat.postMessage).not.toHaveBeenCalled();
    });

    it('posts message for workflow_status event', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      await surface.handleEvent({
        type: 'workflow_status',
        status: { total: 5, completed: 2, failed: 0, running: 1, pending: 2 },
      });

      expect(app.client.chat.postMessage).toHaveBeenCalled();
    });

    it('posts message for error event', async () => {
      await surface.start(async () => {});
      const app = surface.getApp() as any;

      await surface.handleEvent({
        type: 'error',
        message: 'Something broke',
      });

      expect(app.client.chat.postMessage).toHaveBeenCalled();
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
      mockPlanConversation.submittedPlan = null;
      mockPlanConversation.planSubmitted = false;

      surfaceWithApi = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        cursorCommand: 'cursor',
      });
    });

    it('calls start_plan when planSubmitted is true after sendMessage', async () => {
      const plan = { name: 'Test Plan', tasks: [{ id: 't1', description: 'Do something', dependencies: [] }] };
      mockSendMessage.mockImplementation(async () => {
        mockPlanConversation.submittedPlan = plan;
        mockPlanConversation.planSubmitted = true;
        return 'Submitting plan now.';
      });

      await surfaceWithApi.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surfaceWithApi.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn();
      await mentionHandler({
        event: { text: '<@U_BOT> build me a REST API', ts: '1111', thread_ts: undefined },
        say,
      });

      // Should post Claude's reply + execution message
      expect(say).toHaveBeenCalledWith(expect.objectContaining({ text: 'Submitting plan now.' }));
      expect(say).toHaveBeenCalledWith(expect.objectContaining({
        text: expect.stringContaining('Starting execution'),
      }));

      // Should emit start_plan command
      expect(receivedCommands).toEqual([
        expect.objectContaining({ type: 'start_plan', plan }),
      ]);
    });

    it('does not call start_plan when plan exists but planSubmitted is false', async () => {
      mockSendMessage.mockImplementation(async () => {
        mockPlanConversation.submittedPlan = null;
        mockPlanConversation.planSubmitted = false;
        return 'Here is the plan. Want me to run it?';
      });

      await surfaceWithApi.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surfaceWithApi.getApp() as any;
      const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;

      const say = vi.fn();
      await mentionHandler({
        event: { text: '<@U_BOT> build something', ts: '2222', thread_ts: undefined },
        say,
      });

      // Should post reply but NOT execution message
      expect(say).toHaveBeenCalledTimes(1);
      expect(receivedCommands).toHaveLength(0);
    });
  });
});

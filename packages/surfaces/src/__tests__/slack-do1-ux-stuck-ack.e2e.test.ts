/**
 * DO1 e2e: empty `plan:` mentions must not leave a sticky Processing ack.
 * Bolt mock pattern copied from slack-surface-immediate-response.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';

const LIVE_FENCED_PLAN_BOT_REPLY =
  'I’ll treat this as a normal worktree task here, not an Invoker plan\n\nThere are already local edits in the target areas.';
const LIVE_FENCED_PLAN_USER =
  '```text\nplan: Prove and fix the adverse UI test issues found in the agent thread for Invoker.\n\nScope:\n1. Fix/prove @invoker/app build behavior when git SHA lookup hits false EPERM.\n```';
const LIVE_ADVERSE_AGENT_PROSE =
  'I’ll interpret “averse test” as adverse/edge-case UI testing for an Invoker plan';
const LIVE_PATH_LEAK =
  'I inspected [scripts/land-stack.mjs](/home/invoker/.invoker/slack-manager/planning-clones/64a63486912a/scripts/land-stack.mjs:1)';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

interface ApiCall {
  method: 'postMessage' | 'update' | 'delete' | 'reactions.add' | 'reactions.remove';
  timestamp?: string;
  ts?: string;
  text?: string;
  name?: string;
  channel: string;
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
          const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
          apiCalls.push({ method: 'postMessage', channel, text, ts });
          return { ts, ok: true };
        }),
        update: vi.fn().mockImplementation(async ({ channel, ts, text }) => {
          apiCalls.push({ method: 'update', channel, ts, text });
          return { ok: true };
        }),
        delete: vi.fn().mockImplementation(async ({ channel, ts }) => {
          apiCalls.push({ method: 'delete', channel, ts });
          return { ok: true };
        }),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'UBOT123456' }),
      },
      reactions: {
        add: vi.fn().mockImplementation(async ({ channel, timestamp, name }) => {
          apiCalls.push({ method: 'reactions.add', channel, timestamp, name });
          return { ok: true };
        }),
        remove: vi.fn().mockImplementation(async ({ channel, timestamp, name }) => {
          apiCalls.push({ method: 'reactions.remove', channel, timestamp, name });
          return { ok: true };
        }),
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
  init: vi.fn().mockResolvedValue(undefined),
};

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack/plan-conversation.js')>()),
  PlanConversation: vi.fn(() => mockPlanConversation),
}));

describe('DO1 e2e: clear leftover Processing ack on empty plan:', () => {
  let surface: SlackSurface;

  beforeEach(() => {
    apiCalls.length = 0;
    mockSendMessage.mockReset();
    mockDraftedPlan = null;
  });

  it('keeps LIVE DO1 payload fixtures available for this repro', () => {
    expect(LIVE_FENCED_PLAN_BOT_REPLY).toContain('Invoker plan');
    expect(LIVE_FENCED_PLAN_USER).toContain('plan:');
    expect(LIVE_ADVERSE_AGENT_PROSE).toContain('Invoker plan');
    expect(LIVE_PATH_LEAK).toContain('/home/invoker');
  });

  afterEach(async () => {
    if (surface) await surface.stop();
  });

  it('posts Processing then deletes that ack for empty plan: mention', async () => {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      anthropicApiKey: 'test-anthropic-key',
    });
    await surface.start(async () => {});

    const app = surface.getApp() as any;
    const mentionHandler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
    const say = vi.fn().mockImplementation(async ({ text }) => {
      const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
      apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
      return { ts, ok: true };
    });

    await mentionHandler({
      event: { text: '<@UBOT123456> plan:', ts: '3333.001', user: 'U123' },
      say,
    });

    expect(apiCalls[0]).toEqual(expect.objectContaining({
      method: 'postMessage',
      text: 'Processing your request...',
    }));
    expect(apiCalls.some((c) => c.method === 'delete' && c.ts === apiCalls[0].ts)).toBe(true);
    expect(mockSendMessage).not.toHaveBeenCalled();
  });
});

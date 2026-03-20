/**
 * Integration tests for SlackSurface immediate response functionality.
 *
 * Tests the complete flow from user mention to immediate ack to response replacement.
 * These tests verify the integration between:
 * - @mention event handling
 * - Immediate acknowledgment posting
 * - PlanConversation message processing
 * - Message replacement/update logic
 * - Typing indicator coordination
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { splitForSlack } from '../slack/slack-message-helpers.js';
import type { SurfaceCommand } from '../surface.js';

// ── Mock @slack/bolt ────────────────────────────────────────

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

interface MockChatPostMessageResult {
  ts?: string;
  ok: boolean;
}

interface MockReaction {
  channel: string;
  timestamp: string;
  name: string;
}

// Track the sequence of Slack API calls for verification
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

// Mock PlanConversation to control response timing
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

// ── Integration Tests ───────────────────────────────────────

describe('SlackSurface Immediate Response - Integration Tests', () => {
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(() => {
    receivedCommands = [];
    apiCalls.length = 0; // Clear API call history
    mockSendMessage.mockReset();
    mockPlanConversation.submittedPlan = null;
    mockPlanConversation.planSubmitted = false;
  });

  afterEach(async () => {
    if (surface) {
      await surface.stop();
    }
  });

  describe('End-to-End Flow: Mention → Immediate Ack → Response Replacement', () => {
    it('sends immediate ack, processes request, then replaces ack with actual response', async () => {
      // Setup: Create surface with immediate ack enabled (default)
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
      });

      // Mock Claude response
      mockSendMessage.mockResolvedValue('Here is my detailed response to your question.');

      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      // Simulate user @mention
      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text, thread_ts }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> help me debug this issue',
          ts: '1234567890.123456',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Verify the complete flow
      expect(apiCalls.length).toBeGreaterThanOrEqual(2);

      // 1. First call should be immediate acknowledgment
      const firstCall = apiCalls[0];
      expect(firstCall.method).toBe('postMessage');
      expect(firstCall.text).toBe('Processing your request...');

      // 2. Second call should be update replacing the ack with actual response
      const secondCall = apiCalls[1];
      expect(secondCall.method).toBe('update');
      expect(secondCall.text).toBe('Here is my detailed response to your question.');
      expect(secondCall.ts).toBe(firstCall.ts); // Same message timestamp

      // 3. PlanConversation should have been called (text is stripped of @mention by registerMentionHandler)
      // The handler strips <@UBOT123456> before passing to handleConversationMessage
      expect(mockSendMessage).toHaveBeenCalled();
      const actualCall = mockSendMessage.mock.calls[0][0];
      expect(actualCall).toBe('help me debug this issue');
    });

    it('handles plan submission flow correctly', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
      });

      const plan = {
        name: 'Debug Issue',
        tasks: [{ id: 't1', description: 'Run debugger', dependencies: [] }],
      };

      mockSendMessage.mockImplementation(async () => {
        mockPlanConversation.submittedPlan = plan;
        mockPlanConversation.planSubmitted = true;
        return 'Plan ready. Submitting now...';
      });

      await surface.start(async (cmd) => {
        receivedCommands.push(cmd);
      });

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text, thread_ts }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> create a plan for me',
          ts: '1111.001',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Verify flow: ack → replace → execution message
      expect(apiCalls.length).toBeGreaterThanOrEqual(3);

      // 1. Immediate ack
      expect(apiCalls[0].method).toBe('postMessage');
      expect(apiCalls[0].text).toBe('Processing your request...');

      // 2. Replace ack with response
      expect(apiCalls[1].method).toBe('update');
      expect(apiCalls[1].text).toBe('Plan ready. Submitting now...');

      // 3. Execution started message
      expect(apiCalls[2].method).toBe('postMessage');
      expect(apiCalls[2].text).toContain('Starting execution');

      // 4. Command should be emitted
      expect(receivedCommands).toEqual([
        expect.objectContaining({ type: 'start_plan', plan }),
      ]);
    });
  });

  describe('Configuration Options', () => {
    it('disables immediate ack when enableImmediateAck is false', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        enableImmediateAck: false,
      });

      mockSendMessage.mockResolvedValue('Direct response without ack.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> test',
          ts: '2222.002',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Should only post once (no ack, just direct response)
      expect(apiCalls.length).toBe(1);
      expect(apiCalls[0].method).toBe('postMessage');
      expect(apiCalls[0].text).toBe('Direct response without ack.');

      // Should NOT call update
      const updates = apiCalls.filter(c => c.method === 'update');
      expect(updates.length).toBe(0);
    });

    it('uses custom immediate ack message when configured', async () => {
      const customMessage = 'Hold on, thinking...';

      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        immediateAckMessage: customMessage,
      });

      mockSendMessage.mockResolvedValue('Response ready.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> question',
          ts: '3333.003',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // First call should use custom message
      expect(apiCalls[0].text).toBe(customMessage);
    });
  });

  describe('Typing Indicator Integration', () => {
    it('adds reaction before processing, removes after response', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        useTypingIndicator: true,
        enableImmediateAck: false, // Disable ack to test typing indicator in isolation
        immediateAckEmoji: 'hourglass_flowing_sand',
      });

      mockSendMessage.mockResolvedValue('Response from Claude.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      const eventTs = '4444.004';
      await mentionHandler({
        event: {
          text: '<@UBOT123456> help',
          ts: eventTs,
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Verify reaction lifecycle
      const reactionAdds = apiCalls.filter(c => c.method === 'reactions.add');
      const reactionRemoves = apiCalls.filter(c => c.method === 'reactions.remove');

      expect(reactionAdds.length).toBe(1);
      expect(reactionAdds[0].timestamp).toBe(eventTs);
      expect(reactionAdds[0].name).toBe('hourglass_flowing_sand');

      expect(reactionRemoves.length).toBe(1);
      expect(reactionRemoves[0].timestamp).toBe(eventTs);
      expect(reactionRemoves[0].name).toBe('hourglass_flowing_sand');

      // Reaction should be added BEFORE message processing
      const addIndex = apiCalls.findIndex(c => c.method === 'reactions.add');
      const firstMessageIndex = apiCalls.findIndex(c => c.method === 'postMessage');
      expect(addIndex).toBeLessThan(firstMessageIndex);

      // Reaction should be removed BEFORE posting the response (see line 360 of slack-surface.ts)
      const removeIndex = apiCalls.findIndex(c => c.method === 'reactions.remove');
      expect(removeIndex).toBeLessThan(firstMessageIndex);
      // But removed AFTER added
      expect(removeIndex).toBeGreaterThan(addIndex);
    });

    it('does not add reactions when useTypingIndicator is false', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        useTypingIndicator: false,
      });

      mockSendMessage.mockResolvedValue('Response.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> test',
          ts: '5555.005',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Should not have any reaction calls
      const reactionCalls = apiCalls.filter(
        c => c.method === 'reactions.add' || c.method === 'reactions.remove'
      );
      expect(reactionCalls.length).toBe(0);
    });

    it('removes reaction even when message processing fails', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
        useTypingIndicator: true,
      });

      mockSendMessage.mockRejectedValue(new Error('Claude API error'));

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      const eventTs = '6666.006';
      await mentionHandler({
        event: {
          text: '<@UBOT123456> error test',
          ts: eventTs,
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Should still add and remove reaction
      const reactionAdds = apiCalls.filter(c => c.method === 'reactions.add');
      const reactionRemoves = apiCalls.filter(c => c.method === 'reactions.remove');

      expect(reactionAdds.length).toBe(1);
      expect(reactionRemoves.length).toBe(1);
    });
  });

  describe('Edge Cases and Error Handling', () => {
    it('handles ack posting failure gracefully', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
      });

      mockSendMessage.mockResolvedValue('Response after ack failed.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      // Make first say call fail (ack), second succeed (actual response)
      let callCount = 0;
      const say = vi.fn().mockImplementation(async ({ text }) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Failed to post ack');
        }
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> test ack failure',
          ts: '7777.007',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // Should still process and post response
      expect(mockSendMessage).toHaveBeenCalled();

      // Should post response directly (no update since ack failed)
      const messages = apiCalls.filter(c => c.method === 'postMessage');
      expect(messages.length).toBe(1);
      expect(messages[0].text).toBe('Response after ack failed.');
    });

    it('falls back to new message when chat.update fails (msg_too_long)', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
      });

      mockSendMessage.mockResolvedValue('A long response from Claude.');

      await surface.start(async () => {});

      const app = surface.getApp() as any;

      // Make chat.update reject with msg_too_long (push to apiCalls first so we can verify it was attempted)
      app.client.chat.update.mockImplementationOnce(async ({ channel, ts, text }: any) => {
        apiCalls.push({ method: 'update', channel, ts, text });
        throw new Error('An API error occurred: msg_too_long');
      });

      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text, thread_ts }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      await mentionHandler({
        event: {
          text: '<@UBOT123456> explain this code',
          ts: '9999.001',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      // 1. ACK posted
      const posts = apiCalls.filter(c => c.method === 'postMessage');
      expect(posts.length).toBe(2); // ack + fallback message

      // 2. Update was attempted and failed
      const updates = apiCalls.filter(c => c.method === 'update');
      expect(updates.length).toBe(1);

      // 3. Stale ACK deleted
      const deletes = apiCalls.filter(c => c.method === 'delete');
      expect(deletes.length).toBe(1);
      expect(deletes[0].ts).toBe(posts[0].ts); // deleted the ack message

      // 4. Fallback message has the actual response
      expect(posts[1].text).toBe('A long response from Claude.');
    });

    it('maintains correct message sequence in threaded conversation', async () => {
      surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: 'C-test',
        anthropicApiKey: 'test-anthropic-key',
      });

      await surface.start(async () => {});

      const app = surface.getApp() as any;
      const mentionHandler = app._eventHandlers.find(
        (h: MockHandler) => h.pattern === 'app_mention'
      )?.handler;

      const say = vi.fn().mockImplementation(async ({ text }) => {
        const ts = `${Date.now()}.${Math.random().toString(36).substr(2, 6)}`;
        apiCalls.push({ method: 'postMessage', channel: 'C-test', text, ts });
        return { ts, ok: true };
      });

      // First message in thread
      mockSendMessage.mockResolvedValueOnce('First response');
      await mentionHandler({
        event: {
          text: '<@UBOT123456> first question',
          ts: '8888.001',
          thread_ts: undefined,
          user: 'U123',
        },
        say,
      });

      const firstAckTs = apiCalls[0].ts;

      // Second message in same thread
      mockSendMessage.mockResolvedValueOnce('Second response');
      await mentionHandler({
        event: {
          text: '<@UBOT123456> second question',
          ts: '8888.002',
          thread_ts: '8888.001', // Same thread
          user: 'U123',
        },
        say,
      });

      // Should have two separate ack messages
      const messages = apiCalls.filter(c => c.method === 'postMessage');
      expect(messages.length).toBe(2);

      // Each should be replaced independently
      const updates = apiCalls.filter(c => c.method === 'update');
      expect(updates.length).toBe(2);
      expect(updates[0].text).toBe('First response');
      expect(updates[1].text).toBe('Second response');
    });
  });
});

describe('splitForSlack', () => {
  it('returns short text as a single chunk', () => {
    expect(splitForSlack('hello')).toEqual(['hello']);
  });

  it('returns text at exactly the limit as a single chunk', () => {
    const exact = 'a'.repeat(3_800);
    expect(splitForSlack(exact)).toEqual([exact]);
  });

  it('splits long text into multiple chunks at paragraph boundaries', () => {
    const para = 'x'.repeat(2_000);
    const text = `${para}\n\n${para}\n\n${para}`;
    const chunks = splitForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('\n\n')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3_800);
    }
  });

  it('splits at single newlines when a paragraph exceeds the limit', () => {
    const line = 'y'.repeat(100);
    const lines = Array(60).fill(line);
    const text = lines.join('\n');
    const chunks = splitForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3_800);
    }
    expect(chunks.join('\n')).toBe(text);
  });

  it('does not split inside a fenced code block', () => {
    const before = 'a'.repeat(3_000);
    const codeBlock = '```yaml\nname: "Test"\ntasks:\n  - id: t1\n    description: "task"\n```';
    const text = `${before}\n\n${codeBlock}`;
    const chunks = splitForSlack(text);
    const hasUnclosedBlock = chunks.some(c => {
      const fences = (c.match(/^```/gm) || []).length;
      return fences % 2 !== 0;
    });
    expect(hasUnclosedBlock).toBe(false);
  });

  it('splits an oversized code block with fence close/re-open', () => {
    const codeLine = '  key: ' + 'v'.repeat(80);
    const codeLines = Array(80).fill(codeLine);
    const text = '```yaml\n' + codeLines.join('\n') + '\n```';
    const chunks = splitForSlack(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const fences = (chunk.match(/^```/gm) || []).length;
      expect(fences % 2).toBe(0);
    }
  });

  it('accepts a custom limit', () => {
    const text = 'aaaa\n\nbbbb\n\ncccc';
    const chunks = splitForSlack(text, 9);
    expect(chunks.length).toBe(3);
    expect(chunks).toEqual(['aaaa', 'bbbb', 'cccc']);
  });
});

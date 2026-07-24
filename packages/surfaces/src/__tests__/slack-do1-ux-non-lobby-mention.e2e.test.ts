import { describe, expect, it, vi, afterEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _commandHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
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
        postMessage: vi.fn().mockResolvedValue({ ts: '1.1', ok: true }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      conversations: {
        create: vi.fn(),
        invite: vi.fn(),
        list: vi.fn(),
      },
    };
  }
  return { App: MockApp };
});

describe('DO1 Slack UX e2e — non-workflow mention routing', () => {
  let surface: SlackSurface;

  afterEach(async () => {
    if (surface) await surface.stop();
  });

  it('routes @mentions outside workflow channels to planning', async () => {
    const adapter = await SQLiteAdapter.create(':memory:');
    const repo = new WorkflowChannelRepository(adapter);
    repo.save({
      workflowId: 'wf-1',
      channelId: 'CWF',
      createdAt: new Date().toISOString(),
    });
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'secret',
      channelId: 'CLOBBY',
      workflowChannelRepo: repo,
      enableImmediateAck: false,
    });
    await surface.start(async () => {});
    const handlePlanningMention = vi.spyOn(surface as any, 'handlePlanningMention').mockResolvedValue(undefined);

    const app = surface.getApp() as any;
    const mention = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
    const say = vi.fn().mockResolvedValue({ ts: 's1' });
    await mention({
      event: {
        text: '<@UBOT> can you help?',
        ts: 't1',
        thread_ts: 't1',
        user: 'U1',
        channel: 'COTHER',
      },
      say,
    });

    expect(handlePlanningMention).toHaveBeenCalledWith(
      expect.objectContaining({ channel: 'COTHER', ts: 't1' }),
      say,
      'COTHER',
    );
  });
});

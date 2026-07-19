/**
 * DO1 Slack UX e2e: workflow control must not claim success when onCommand fails.
 * Live symptom: thread said "Approving…" while lobby root said Invoker is down.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
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

describe('DO1 Slack UX e2e — command error in thread', () => {
  let surface: SlackSurface;
  let adapter: SQLiteAdapter;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(async () => {
    if (surface) await surface.stop();
  });

  it('says the failure in-thread instead of Approving when onCommand throws', async () => {
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
    await surface.start(async () => {
      throw new Error('Invoker is down and I could not bring it back. Reply `@Invoker restart` to retry.');
    });

    const app = surface.getApp() as any;
    const mention = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
    const say = vi.fn().mockResolvedValue({ ts: 's1' });
    await mention({
      event: {
        text: '<@UBOT> approve hello',
        ts: 't1',
        thread_ts: 't1',
        user: 'U1',
        channel: 'CWF',
      },
      say,
      context: {},
      body: { event: { channel: 'CWF' } },
    });

    const texts = say.mock.calls.map((c) => c[0].text).join('\n');
    expect(texts).toContain('Invoker is down');
    expect(texts).not.toMatch(/^Approving /m);
  });
});

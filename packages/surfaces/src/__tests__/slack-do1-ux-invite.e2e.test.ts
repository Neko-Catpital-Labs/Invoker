import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';

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

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _commandHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => { this._commandHandlers.push({ pattern: name, handler }); });
    action = vi.fn((pattern: string | RegExp, handler: Function) => { this._actionHandlers.push({ pattern, handler }); });
    event = vi.fn((name: string, handler: Function) => { this._eventHandlers.push({ pattern: name, handler }); });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1.1' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
      reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
      conversations: {
        create: vi.fn().mockResolvedValue({ channel: { id: 'C_NEW' } }),
        invite: vi.fn().mockResolvedValue({}),
        list: vi.fn().mockResolvedValue({ channels: [] }),
      },
    };
  }
  return { App: MockApp };
});

const silentLog = () => {};

function baseConfig() {
  return {
    botToken: 'xoxb', appToken: 'xapp', signingSecret: 's', channelId: 'CLOBBY', log: silentLog,
  };
}

describe('DO1 e2e: surface Slack workflow-channel invite failures', () => {
  let adapter: SQLiteAdapter;
  let repo: WorkflowChannelRepository;

  beforeEach(async () => {
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new WorkflowChannelRepository(adapter);
    expect(LIVE_FENCED_PLAN_BOT_REPLY.length).toBeGreaterThan(0);
    expect(LIVE_FENCED_PLAN_USER.length).toBeGreaterThan(0);
    expect(LIVE_ADVERSE_AGENT_PROSE.length).toBeGreaterThan(0);
    expect(LIVE_PATH_LEAK.length).toBeGreaterThan(0);
  });

  it('workflow_created with invite missing_scope posts lobby text containing could not invite you', async () => {
    const surface = new SlackSurface({ ...baseConfig(), workflowChannelRepo: repo });
    const client = (surface.getApp() as any).client;
    client.conversations.invite.mockRejectedValueOnce({ data: { error: 'missing_scope' } });

    await surface.handleEvent({
      type: 'workflow_created', workflowId: 'wf-1-2', requestedBy: 'U1',
      lobbyChannel: 'CLOBBY', lobbyThreadTs: 't1',
    });

    const lobbyPost = client.chat.postMessage.mock.calls.find((c: any[]) => c[0].channel === 'CLOBBY')?.[0];
    expect(lobbyPost?.text).toContain('could not invite you');
    expect(lobbyPost?.text).toContain('missing_scope');
  });
});

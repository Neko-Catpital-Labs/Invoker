import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Channels } from '@invoker/transport';
import { ConversationRepository, SQLiteAdapter, WorkflowChannelRepository } from '@invoker/data-store';
import { SlackSurface } from '../../../surfaces/src/slack/slack-surface.js';
import { createCommandHandler } from '../command-handler.js';
import { startEventSubscription } from '../event-subscription.js';
import type { InvokerClient } from '../invoker-client.js';

interface Handler {
  pattern: string | RegExp;
  handler: Function;
}

const bolt = vi.hoisted(() => ({
  client: {
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      create: vi.fn().mockResolvedValue({ channel: { id: 'C_WORKFLOW' } }),
      invite: vi.fn().mockResolvedValue({}),
      list: vi.fn().mockResolvedValue({ channels: [] }),
    },
    reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
  },
}));

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: Handler[] = [];
    command = vi.fn();
    event = vi.fn((pattern: string, handler: Function) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = bolt.client;
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = () => {};
const plan = `\`\`\`yaml
name: "Host integration"
tasks:
  - id: proof
    description: "Prove the supported chain"
    command: "pnpm test"
    dependencies: []
\`\`\`
`;

function plannerOutput(stdout: string): any {
  const child = new EventEmitter() as any;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', 0);
  });
  return child;
}

function eventHandler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: Handler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

function fakeClient() {
  const subscribers = new Map<string, (message: unknown) => void>();
  const client: InvokerClient = {
    ping: vi.fn(async () => true),
    isHealthy: vi.fn(async () => true),
    listWorkflows: vi.fn(async () => []),
    getWorkflowBundle: vi.fn(async () => ({ workflow: undefined, tasks: [] })),
    getWorkflowStatus: vi.fn(async () => ({ total: 0, completed: 0, failed: 0, closed: 0, running: 0, pending: 0 })),
    getTaskOutput: vi.fn(async () => ''),
    exec: vi.fn(async () => {}),
    run: vi.fn(async () => 'wf-host-proof'),
    launch: vi.fn(async () => true),
    withRecovery: vi.fn(async (fn: () => Promise<unknown>) => fn()) as InvokerClient['withRecovery'],
    subscribe: vi.fn((channel, handler) => {
      subscribers.set(channel, handler);
      return () => subscribers.delete(channel);
    }),
    onReconnect: vi.fn(() => () => {}),
    disconnect: vi.fn(),
  };
  return { client, subscribers };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Slack manager host integration', () => {
  let adapter: SQLiteAdapter;
  let surface: SlackSurface;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockSpawn.mockReset();
    adapter = await SQLiteAdapter.create(':memory:');
  });

  afterEach(async () => {
    await surface?.stop();
    adapter.close();
  });

  it('submits an explicit plan and routes IPC updates to its private workflow channel', async () => {
    const conversations = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    const workflowChannels = new WorkflowChannelRepository(adapter);
    const { client, subscribers } = fakeClient();
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test',
      channelId: 'C_DEFAULT',
      lobbyChannelId: 'C_LOBBY',
      conversationRepo: conversations,
      workflowChannelRepo: workflowChannels,
      defaultRepoUrl: 'https://github.com/example/repo.git',
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    await surface.start(createCommandHandler({
      client,
      slack: surface,
      plansDir: mkdtempSync(path.join(tmpdir(), 'slack-host-plans-')),
      log: silentLog,
    }));
    startEventSubscription({ client, slack: surface, log: silentLog });
    await settle();

    mockSpawn.mockImplementationOnce(() => plannerOutput(plan));
    const mention = eventHandler(surface, 'app_mention');
    const reply = eventHandler(surface, 'message');
    const say = vi.fn().mockResolvedValue({ ts: 'reply' });
    await mention({ event: { text: '<@UBOT> plan: prove the host route', ts: '100.1', user: 'U_REQUESTER', channel: 'C_LOBBY' }, say });
    await mention({ event: { text: '<@UBOT> submit', ts: '100.2', thread_ts: '100.1', user: 'U_REQUESTER', channel: 'C_LOBBY' }, say });
    await reply({ event: { text: 'yes', ts: '100.3', thread_ts: '100.1', user: 'U_REQUESTER', channel: 'C_LOBBY' }, say });

    expect(client.run).toHaveBeenCalledOnce();
    expect(bolt.client.conversations.create).toHaveBeenCalledWith({ name: 'workflow-host-proof', is_private: true });
    expect(bolt.client.conversations.invite).toHaveBeenCalledWith({ channel: 'C_WORKFLOW', users: 'U_REQUESTER' });
    expect(workflowChannels.getByWorkflowId('wf-host-proof')).toEqual(expect.objectContaining({
      channelId: 'C_WORKFLOW',
      lobbyChannelId: 'C_LOBBY',
      lobbyThreadTs: '100.1',
    }));

    subscribers.get(Channels.SURFACE_EVENT)!({
      type: 'workflow_progress',
      progress: {
        workflowId: 'wf-host-proof',
        name: 'Host integration',
        counts: { total: 1, completed: 0, failed: 0, closed: 0, running: 1, pending: 0 },
        percentComplete: 0,
        tasks: [],
      },
    });
    subscribers.get(Channels.TASK_DELTA)!({
      type: 'updated',
      taskId: 'wf-host-proof/proof',
      changes: { status: 'awaiting_approval' },
    });
    await settle();

    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_WORKFLOW',
      text: expect.stringContaining('Host integration'),
    }));
    expect(bolt.client.chat.postMessage).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'C_WORKFLOW',
      text: 'Task wf-host-proof/proof: Awaiting Approval',
    }));
  });
});

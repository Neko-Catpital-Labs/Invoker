import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { ConversationRepository, SQLiteAdapter, SlackSessionRepository } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

const sharedSlack = vi.hoisted(() => ({
  client: {
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
    chat: {
      postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
      update: vi.fn().mockResolvedValue({}),
      delete: vi.fn().mockResolvedValue({}),
    },
    reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
  },
}));

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    command = vi.fn();
    event = vi.fn((pattern: string, handler: Function) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn((pattern: string | RegExp, handler: Function) => this._actionHandlers.push({ pattern, handler }));
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = sharedSlack.client;
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = () => {};
const plan = `\`\`\`yaml
name: "Pink Yellow theme"
repoUrl: "https://github.com/EdbertChan/notarepo"
tasks:
  - id: theme
    description: "Change the theme"
    command: "pnpm test"
    dependencies: []
\`\`\``;

function processWith(stdout: string): any {
  const process = new EventEmitter() as any;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  queueMicrotask(() => {
    process.stdout.emit('data', Buffer.from(stdout));
    process.emit('close', 0);
  });
  return process;
}

function handler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: MockHandler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

function actionHandler(surface: SlackSurface, pattern: string): Function {
  const found = (surface.getApp() as any)._actionHandlers.find((entry: MockHandler) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} action handler`);
  return found.handler;
}

function buttonValue(say: ReturnType<typeof vi.fn>, actionId: string): string {
  for (const [message] of say.mock.calls) {
    for (const block of message.blocks ?? []) {
      const button = block.elements?.find((element: { action_id?: string }) => element.action_id === actionId);
      if (button?.value) return button.value;
    }
  }
  throw new Error(`Missing ${actionId} button`);
}

describe('Slack plan-intent confirmation repro', () => {
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.update.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    conversationRepo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    commands = [];
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test',
      channelId: 'C_LOBBY',
      lobbyChannelId: 'C_LOBBY',
      defaultRepoUrl: 'https://github.com/EdbertChan/notarepo',
      conversationRepo,
      slackSessionRepo: new SlackSessionRepository(adapter),
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    await surface.start(async (command) => { commands.push(command); });
  });

  afterEach(async () => {
    await surface.stop();
    adapter.close();
  });

  it('requires plan intent confirmation before drafting, then reuses Approve to execute', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'theme-intent-message' });
    await handler(surface, 'app_mention')({
      event: {
        text: '<@UBOT> /plan lets change the theme to Pink/Yellow for https://github.com/EdbertChan/notarepo',
        ts: 'theme-thread',
        user: 'U_TEST',
        channel: 'C_LOBBY',
      },
      say,
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    expect(buttonValue(say, 'lobby_continue_conversation')).toBeTruthy();
    expect(() => buttonValue(say, 'lobby_confirm')).toThrow('Missing lobby_confirm button');

    mockSpawn.mockImplementationOnce(() => processWith(plan));
    const planIntentKey = buttonValue(say, 'lobby_plan_for_execution');
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: planIntentKey },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'theme-intent-message', thread_ts: 'theme-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mockSpawn.mock.calls[0])).toContain('Pink/Yellow');
    expect([...((surface as any).pendingConfirms.values())]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'submit' }),
    ]));

    const draftMessage = sharedSlack.client.chat.postMessage.mock.calls.at(-1)?.[0];
    const approve = draftMessage?.blocks?.flatMap((block: any) => block.elements ?? [])
      .find((element: any) => element.action_id === 'lobby_confirm');
    expect(approve).toEqual(expect.objectContaining({ text: expect.objectContaining({ text: 'Approve' }) }));
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('continues the original request without drafting when planning is declined', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'continue-intent-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan change the theme to Pink/Yellow', ts: 'continue-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    mockSpawn.mockImplementationOnce(() => processWith('I will continue the conversation.'));
    await actionHandler(surface, 'lobby_continue_conversation')({
      action: { type: 'button', value: buttonValue(say, 'lobby_continue_conversation') },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'continue-intent-message', thread_ts: 'continue-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect([...((surface as any).pendingConfirms.values())]).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'submit' }),
    ]));
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });

  it('restores a persisted planning choice after a Slack surface restart', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'restart-intent-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan change the theme to Pink/Yellow', ts: 'restart-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    const key = buttonValue(say, 'lobby_plan_for_execution');
    await surface.stop();

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test',
      channelId: 'C_LOBBY',
      lobbyChannelId: 'C_LOBBY',
      defaultRepoUrl: 'https://github.com/EdbertChan/notarepo',
      conversationRepo,
      slackSessionRepo: new SlackSessionRepository(adapter),
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    await surface.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'restart-intent-message', thread_ts: 'restart-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect([...((surface as any).pendingConfirms.values())]).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'submit' }),
    ]));
  });
});

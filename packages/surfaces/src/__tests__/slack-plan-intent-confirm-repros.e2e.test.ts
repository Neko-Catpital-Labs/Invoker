import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { ConversationRepository, SQLiteAdapter, SlackPlanDraftRepository, SlackSessionRepository } from '@invoker/data-store';
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
    files: { uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F_PLAN' }] }) },
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

function processWithFailure(exitCode: number, stderr: string): any {
  const process = new EventEmitter() as any;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  queueMicrotask(() => {
    process.stderr.emit('data', Buffer.from(stderr));
    process.emit('close', exitCode);
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
  let slackPlanDraftRepo: SlackPlanDraftRepository;
  let slackSessionRepo: SlackSessionRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.update.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    conversationRepo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackPlanDraftRepo = new SlackPlanDraftRepository(adapter);
    slackSessionRepo = new SlackSessionRepository(adapter);
    commands = [];
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test',
      channelId: 'C_LOBBY',
      lobbyChannelId: 'C_LOBBY',
      defaultRepoUrl: 'https://github.com/EdbertChan/notarepo',
      conversationRepo,
      slackSessionRepo,
      slackPlanDraftRepo,
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
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    const planIntentKey = buttonValue(say, 'lobby_plan_for_execution');
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: planIntentKey },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'theme-intent-message', thread_ts: 'theme-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(mockSpawn.mock.calls[0])).toContain('Pink/Yellow');
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
    expect(slackSessionRepo.getPendingConfirmation(planIntentKey)).toBeNull();
  });

  it('continues the original request without drafting when planning is declined', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'continue-intent-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan change the theme to Pink/Yellow', ts: 'continue-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    const continueKey = buttonValue(say, 'lobby_continue_conversation');
    mockSpawn.mockImplementationOnce(() => processWith('I will continue the conversation.'));
    await actionHandler(surface, 'lobby_continue_conversation')({
      action: { type: 'button', value: continueKey },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'continue-intent-message', thread_ts: 'continue-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(slackPlanDraftRepo.getReady('C_LOBBY', 'continue-thread')).toBeUndefined();
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
    expect(slackSessionRepo.getPendingConfirmation(continueKey)).toBeNull();
  });

  it('does not let a stale persisted plan_intent confirmation hijack the next thread reply', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'stale-intent-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan change the theme to Pink/Yellow', ts: 'stale-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    const key = buttonValue(say, 'lobby_continue_conversation');
    mockSpawn.mockImplementationOnce(() => processWith('I will continue the conversation.'));
    await actionHandler(surface, 'lobby_continue_conversation')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'stale-intent-message', thread_ts: 'stale-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    // The persisted row must be gone, or the next plain-text reply in this
    // thread rehydrates the stale plan_intent confirmation via getPendingConfirm
    // and gets misrouted (e.g. into runConfirmedRestart) instead of the agent.
    expect(slackSessionRepo.getPendingConfirmation('stale-thread')).toBeNull();
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
      slackPlanDraftRepo,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    await surface.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(plan));
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'restart-intent-message', thread_ts: 'restart-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(2);
  });

  it('does not let a second plan-intent ask silently replace an unanswered one in the same thread', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'clobber-first-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan add feature A', ts: 'clobber-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    const firstKey = buttonValue(say, 'lobby_plan_for_execution');
    say.mockClear();

    // The user (or an agent asking on its own) tries to start a second plan-intent
    // ask in the same thread before the first one has been answered. thread_ts
    // points back at the original message, exactly like a real threaded reply.
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan actually add feature B instead', ts: 'clobber-thread-2', thread_ts: 'clobber-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    // No second set of buttons, and the user is told why.
    expect(() => buttonValue(say, 'lobby_plan_for_execution')).toThrow('Missing lobby_plan_for_execution button');
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('already a pending confirmation'),
    }));

    // The original ask must still be intact and resolve to the original request.
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: firstKey },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'clobber-first-message', thread_ts: 'clobber-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });
    expect(JSON.stringify(mockSpawn.mock.calls[0])).toContain('feature A');
    expect(JSON.stringify(mockSpawn.mock.calls[0])).not.toContain('feature B');
  });

  it('lets Approve be clicked again if drafting the plan itself fails', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'fail-intent-message' });
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> /plan add feature A', ts: 'fail-thread', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    const key = buttonValue(say, 'lobby_plan_for_execution');

    // The agent turn succeeds, but the planner call itself blows up (e.g. an
    // infra failure), mirroring what "Application quit" was actually masking.
    mockSpawn.mockImplementationOnce(() => processWith('got it, continuing'));
    mockSpawn.mockImplementationOnce(() => processWithFailure(1, 'planner crashed: OAuth session expired'));
    const respond = vi.fn().mockResolvedValue(undefined);
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'fail-intent-message', thread_ts: 'fail-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    // The user must be told it failed, not left with silence after "Planning for execution."
    // Button-triggered replies post via the Slack client, not the mention `say`.
    expect(sharedSlack.client.chat.postMessage.mock.calls.some(
      ([msg]: [{ text?: string }]) => typeof msg?.text === 'string' && /failed/i.test(msg.text),
    )).toBe(true);

    // And the confirmation must still be retryable without retyping the request.
    expect(slackSessionRepo.getPendingConfirmation(key)).not.toBeNull();

    mockSpawn.mockImplementationOnce(() => processWith('got it, continuing'));
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'fail-intent-message', thread_ts: 'fail-thread' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(4);
    expect(slackSessionRepo.getPendingConfirmation(key)).toBeNull();
  });
});

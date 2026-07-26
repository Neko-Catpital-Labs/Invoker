/**
 * Repro contracts for issue 2: clicking Approve must never report
 * "This confirmation has expired." — every drafted plan stays tied to the
 * message that presented it and is submittable any time.
 *
 * Root causes under test:
 *  - one pending confirmation per thread keyed by threadTs, so a newer draft
 *    silently replaces an older draft's staged plan (B1);
 *  - submitting one draft poisons recovery for every other draft message in
 *    the thread via planSubmitted (B2);
 *  - a 24h persistence TTL makes restart-surviving confirmations expire (B3);
 *  - the pending confirmation is deleted before dispatch, so a failed
 *    dispatch leaves nothing to retry (B4).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ConversationRepository, SlackSessionRepository, SQLiteAdapter } from '@invoker/data-store';
import { SlackSurface } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

type MockHandlerFn = (args: Record<string, unknown>) => Promise<void> | void;

interface MockHandler {
  pattern: string | RegExp;
  handler: MockHandlerFn;
}

interface MockAppInternals {
  _eventHandlers: MockHandler[];
  _actionHandlers: MockHandler[];
  _commandHandlers: MockHandler[];
}

interface SlackButtonElement {
  action_id?: string;
  value?: string;
}

interface SlackBlock {
  type?: string;
  elements?: SlackButtonElement[];
}

interface SaidMessage {
  text?: string;
  blocks?: SlackBlock[];
  thread_ts?: string;
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
    _commandHandlers: MockHandler[] = [];
    command = vi.fn((pattern: string, handler: MockHandlerFn) => this._commandHandlers.push({ pattern, handler }));
    event = vi.fn((pattern: string, handler: MockHandlerFn) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn((pattern: string | RegExp, handler: MockHandlerFn) => this._actionHandlers.push({ pattern, handler }));
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
const silentLog = (): void => {};

const planFirst = `\`\`\`yaml
name: "First"
tasks:
  - id: first-task
    description: "Ship draft one"
    command: "pnpm test"
    dependencies: []
\`\`\``;

const planSecond = `\`\`\`yaml
name: "Second"
tasks:
  - id: second-task
    description: "Ship draft two"
    command: "pnpm test"
    dependencies: []
\`\`\``;

function processWith(stdout: string): ChildProcess {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: Mock };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from(stdout));
    proc.emit('close', 0);
  });
  // The planner only touches stdout/stderr/kill/close, so this stub stands in for a real ChildProcess.
  return proc as unknown as ChildProcess;
}

function internals(surface: SlackSurface): MockAppInternals {
  return surface.getApp() as unknown as MockAppInternals;
}

function handler(surface: SlackSurface, pattern: string): MockHandlerFn {
  const found = internals(surface)._eventHandlers.find((entry) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} handler`);
  return found.handler;
}

function actionHandler(surface: SlackSurface, pattern: string): MockHandlerFn {
  const found = internals(surface)._actionHandlers.find((entry) => entry.pattern === pattern);
  if (!found) throw new Error(`Missing ${pattern} action handler`);
  return found.handler;
}

async function mention(surface: SlackSurface, text: string, ts: string, threadTs?: string): Promise<Mock> {
  const say = vi.fn().mockResolvedValue({ ts: `${ts}-reply` });
  await handler(surface, 'app_mention')({
    event: { text: `<@UBOT> ${text}`, ts, thread_ts: threadTs, user: 'U_PROOF', channel: 'C_LOBBY' },
    say,
  });
  return say;
}

async function slashCommand(surface: SlackSurface, text: string): Promise<Mock> {
  const found = internals(surface)._commandHandlers.find((entry) => entry.pattern === '/invoker');
  if (!found) throw new Error('Missing /invoker command handler');
  const respond = vi.fn().mockResolvedValue(undefined);
  await found.handler({
    command: { text, channel_id: 'C_LOBBY', user_id: 'U_PROOF', user_name: 'proof' },
    ack: vi.fn().mockResolvedValue(undefined),
    respond,
  });
  return respond;
}

function confirmValueFrom(mock: Mock): string {
  for (const call of mock.mock.calls) {
    const message = call[0] as SaidMessage | undefined;
    for (const block of message?.blocks ?? []) {
      for (const element of block.elements ?? []) {
        if (element.action_id === 'lobby_confirm' && typeof element.value === 'string') {
          return element.value;
        }
      }
    }
  }
  throw new Error('No lobby_confirm button found');
}

async function clickConfirm(
  surface: SlackSurface,
  value: string,
  thread?: { threadTs: string; messageTs: string },
): Promise<Mock> {
  const respond = vi.fn().mockResolvedValue(undefined);
  await actionHandler(surface, 'lobby_confirm')({
    action: { type: 'button', value },
    body: {
      ...(thread
        ? { channel: { id: 'C_LOBBY' }, message: { ts: thread.messageTs, thread_ts: thread.threadTs } }
        : {}),
      user: { id: 'U_PROOF' },
    },
    ack: vi.fn().mockResolvedValue(undefined),
    respond,
  });
  return respond;
}

function respondedWithExpired(respond: Mock): boolean {
  return respond.mock.calls.some((call) => {
    const message = call[0] as { text?: string } | undefined;
    return typeof message?.text === 'string' && message.text.includes('expired');
  });
}

describe('Slack confirmation expiry repro contracts', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let surfaces: SlackSurface[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    surfaces = [];
  });

  afterEach(async () => {
    vi.useRealTimers();
    await Promise.all(surfaces.map((surface) => surface.stop()));
    adapter.close();
  });

  function surface(commands: SurfaceCommand[]): SlackSurface {
    const created = new SlackSurface({
      botToken: 'xoxb-proof',
      appToken: 'xapp-proof',
      signingSecret: 'proof',
      channelId: 'C_DEFAULT',
      defaultRepoUrl: 'https://github.com/example/repo.git',
      lobbyChannelId: 'C_LOBBY',
      conversationRepo: repo,
      slackSessionRepo: slackSessions,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    surfaces.push(created);
    return created;
  }

  it('submits the plan presented by the clicked message, not the latest draft in the thread', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await slack.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(planFirst));
    const sayFirst = await mention(slack, 'plan: draft one', 'thread-b1');
    const valueFirst = confirmValueFrom(sayFirst);

    mockSpawn.mockImplementationOnce(() => processWith(planSecond));
    await mention(slack, 'plan: draft two instead', 'b1-turn2', 'thread-b1');

    await clickConfirm(slack, valueFirst, { threadTs: 'thread-b1', messageTs: 'msg-first' });

    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });

  it('submits an older draft message after a sibling draft in the thread was already approved', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await slack.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(planFirst));
    const sayFirst = await mention(slack, 'plan: draft one', 'thread-b2');
    const valueFirst = confirmValueFrom(sayFirst);

    mockSpawn.mockImplementationOnce(() => processWith(planSecond));
    const saySecond = await mention(slack, 'plan: draft two instead', 'b2-turn2', 'thread-b2');
    const valueSecond = confirmValueFrom(saySecond);

    await clickConfirm(slack, valueSecond, { threadTs: 'thread-b2', messageTs: 'msg-second' });
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: Second'),
    }));

    const respond = await clickConfirm(slack, valueFirst, { threadTs: 'thread-b2', messageTs: 'msg-first' });

    expect(respondedWithExpired(respond)).toBe(false);
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });

  it('honors a staged confirmation more than 24 hours old across a restart', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands);
    await first.start(async (command) => { commands.push(command); });

    mockSpawn.mockImplementationOnce(() => processWith(planFirst));
    await mention(first, 'plan: draft one', 'thread-b3');
    // Stage via /invoker submit: the confirmation key is not the threadTs, so
    // the persisted row is the only recovery source after a restart.
    const respondSlash = await slashCommand(first, 'submit');
    const value = confirmValueFrom(respondSlash);

    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    // Advance only the clock (real timers stay live) past the 24h TTL.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));

    const second = surface(commands);
    await second.start(async (command) => { commands.push(command); });

    const respond = await clickConfirm(second, value);

    expect(respondedWithExpired(respond)).toBe(false);
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });

  it('keeps the confirmation staged when dispatch fails so Approve can be clicked again', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    let failFirst = true;
    await slack.start(async (command) => {
      if (command.type === 'start_plan' && failFirst) {
        failFirst = false;
        throw new Error('dispatch pipe broke');
      }
      commands.push(command);
    });

    mockSpawn.mockImplementationOnce(() => processWith(planFirst));
    const say = await mention(slack, 'plan: draft one', 'thread-b4');
    const value = confirmValueFrom(say);

    const firstRespond = await clickConfirm(slack, value, { threadTs: 'thread-b4', messageTs: 'msg-b4' });
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
    expect(respondedWithExpired(firstRespond)).toBe(false);

    const secondRespond = await clickConfirm(slack, value, { threadTs: 'thread-b4', messageTs: 'msg-b4' });

    expect(respondedWithExpired(secondRespond)).toBe(false);
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });
});

/**
 * Repro contracts for issue 2: clicking Approve on the current Slack plan
 * review must act on that exact durable PlanDraft record, not on mutable
 * thread state or a 24h pending-confirm TTL.
 *
 * Root causes under test:
 *  - approval values carry draftId/version, so the current draft cannot be
 *    confused with arbitrary latest thread state (B1);
 *  - superseded and failed cards report their real state instead of an
 *    expired pending-confirm message (B2/B4);
 *  - review records survive SlackSurface restarts without expiring at 24h (B3).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { ConversationRepository, SlackPlanDraftRepository, SlackSessionRepository, SQLiteAdapter } from '@invoker/data-store';
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
    files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F-proof' }] }] }) },
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

function actionValueFromLatestUpdatedCard(actionId: string): string {
  for (const call of [...sharedSlack.client.chat.update.mock.calls].reverse()) {
    const message = call[0] as SaidMessage | undefined;
    for (const block of message?.blocks ?? []) {
      for (const element of block.elements ?? []) {
        if (element.action_id === actionId && typeof element.value === 'string') {
          return element.value;
        }
      }
    }
  }
  throw new Error(`No ${actionId} button found`);
}

async function clickPlanDraftApprove(
  surface: SlackSurface,
  value: string,
  thread: { threadTs: string },
): Promise<Mock> {
  const respond = vi.fn().mockResolvedValue(undefined);
  await actionHandler(surface, 'plan_draft_approve')({
    action: { type: 'button', value },
    body: {
      channel: { id: 'C_LOBBY' },
      message: { ts: 'review-message', thread_ts: thread.threadTs },
      user: { id: 'U_PROOF' },
    },
    ack: vi.fn().mockResolvedValue(undefined),
    respond,
  });
  return respond;
}

function respondedWithText(respond: Mock, text: string): boolean {
  return respond.mock.calls.some((call) => {
    const message = call[0] as { text?: string } | undefined;
    return typeof message?.text === 'string' && message.text.includes(text);
  });
}

describe('Slack confirmation expiry repro contracts', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let slackSessions: SlackSessionRepository;
  let slackPlanDrafts: SlackPlanDraftRepository;
  let surfaces: SlackSurface[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    sharedSlack.client.files.uploadV2.mockClear();
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessions = new SlackSessionRepository(adapter);
    slackPlanDrafts = new SlackPlanDraftRepository(adapter);
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
      slackPlanDraftRepo: slackPlanDrafts,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      workingDir: process.cwd(),
      log: silentLog,
    });
    surfaces.push(created);
    return created;
  }

  async function startThread(slack: SlackSurface, threadTs: string): Promise<void> {
    mockSpawn.mockImplementationOnce(() => processWith('Scope captured.'));
    await mention(slack, 'build this', threadTs);
  }

  async function draftPlan(slack: SlackSurface, threadTs: string, planText: string, turnTs: string): Promise<string> {
    mockSpawn.mockImplementationOnce(() => processWith(planText));
    await mention(slack, '/plan', turnTs, threadTs);
    const value = actionValueFromLatestUpdatedCard('plan_draft_approve');
    const draft = slackPlanDrafts.getReady('C_LOBBY', threadTs);
    expect(value).toBe(`${draft?.draftId}:${draft?.version}`);
    return value;
  }

  it('submits the PlanDraft presented by the clicked review card', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await slack.start(async (command) => { commands.push(command); });

    await startThread(slack, 'thread-b1');
    const valueFirst = await draftPlan(slack, 'thread-b1', planFirst, 'b1-plan');

    await clickPlanDraftApprove(slack, valueFirst, { threadTs: 'thread-b1' });

    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });

  it('reports a superseded sibling draft honestly after the current draft is approved', async () => {
    const commands: SurfaceCommand[] = [];
    const slack = surface(commands);
    await slack.start(async (command) => { commands.push(command); });

    await startThread(slack, 'thread-b2');
    const valueFirst = await draftPlan(slack, 'thread-b2', planFirst, 'b2-plan-1');
    const valueSecond = await draftPlan(slack, 'thread-b2', planSecond, 'b2-plan-2');

    await clickPlanDraftApprove(slack, valueSecond, { threadTs: 'thread-b2' });
    expect(commands).toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: Second'),
    }));

    const respond = await clickPlanDraftApprove(slack, valueFirst, { threadTs: 'thread-b2' });

    expect(respondedWithText(respond, 'superseded')).toBe(true);
    expect(commands).not.toContainEqual(expect.objectContaining({
      type: 'start_plan',
      planText: expect.stringContaining('name: First'),
    }));
  });

  it('honors a staged confirmation more than 24 hours old across a restart', async () => {
    const commands: SurfaceCommand[] = [];
    const first = surface(commands);
    await first.start(async (command) => { commands.push(command); });

    await startThread(first, 'thread-b3');
    const value = await draftPlan(first, 'thread-b3', planFirst, 'b3-plan');

    await first.stop();
    surfaces = surfaces.filter((candidate) => candidate !== first);

    // Advance only the clock (real timers stay live) past the 24h TTL.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(Date.now() + 25 * 3600 * 1000));

    const second = surface(commands);
    await second.start(async (command) => { commands.push(command); });

    const respond = await clickPlanDraftApprove(second, value, { threadTs: 'thread-b3' });

    expect(respondedWithText(respond, 'expired')).toBe(false);
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

    await startThread(slack, 'thread-b4');
    const value = await draftPlan(slack, 'thread-b4', planFirst, 'b4-plan');

    const firstRespond = await clickPlanDraftApprove(slack, value, { threadTs: 'thread-b4' });
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
    expect(respondedWithText(firstRespond, 'dispatch pipe broke')).toBe(true);

    const secondRespond = await clickPlanDraftApprove(slack, value, { threadTs: 'thread-b4' });

    expect(respondedWithText(secondRespond, 'failed')).toBe(true);
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
  });
});

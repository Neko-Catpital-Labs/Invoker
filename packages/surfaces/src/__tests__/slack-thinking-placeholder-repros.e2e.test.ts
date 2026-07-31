/**
 * Repro contracts for issue 3: "Still thinking…" / "Processing your request…"
 * placeholders must stay visible until the real response is posted.
 *
 * Root causes under test:
 *  - question intent deletes the immediate ack before the one-shot planner
 *    even starts, leaving the thread silent for the whole answer time (C1);
 *  - heartbeat messages are deleted before the reply is posted, so a stalled
 *    reply post leaves a silent gap (C2).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type * as planConversationModule from '../slack/plan-conversation.js';
import { SlackSurface } from '../slack/slack-surface.js';

type MockHandlerFn = (args: Record<string, unknown>) => Promise<void> | void;

interface MockHandler {
  pattern: string | RegExp;
  handler: MockHandlerFn;
}

interface MockAppInternals {
  _eventHandlers: MockHandler[];
}

interface ApiCall {
  method: 'postMessage' | 'update' | 'delete';
  text?: string;
  ts?: string;
  channel?: string;
}

interface SaidMessage {
  text?: string;
  thread_ts?: string;
}

const apiCalls = vi.hoisted((): ApiCall[] => []);

vi.mock('@slack/bolt', () => {
  class MockApp {
    _eventHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    command = vi.fn();
    event = vi.fn((pattern: string, handler: MockHandlerFn) => this._eventHandlers.push({ pattern, handler }));
    action = vi.fn();
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      chat: {
        postMessage: vi.fn(async (message: { channel?: string; text?: string }) => {
          const ts = `client.${apiCalls.length}`;
          apiCalls.push({ method: 'postMessage', channel: message.channel, text: message.text, ts });
          return { ts, ok: true };
        }),
        update: vi.fn(async (message: { channel?: string; ts?: string; text?: string }) => {
          apiCalls.push({ method: 'update', channel: message.channel, ts: message.ts, text: message.text });
          return { ok: true };
        }),
        delete: vi.fn(async (message: { channel?: string; ts?: string }) => {
          apiCalls.push({ method: 'delete', channel: message.channel, ts: message.ts });
          return { ok: true };
        }),
      },
      reactions: { add: vi.fn().mockResolvedValue({}), remove: vi.fn().mockResolvedValue({}) },
      conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
    };
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const conversationMock = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  getDraftedPlan: vi.fn((): string | null => null),
  submittedPlanText: null as string | null,
  planSubmitted: false,
  conversationMode: 'plan' as const,
  init: vi.fn(async (): Promise<void> => {}),
  lastTurnReasoning: [] as string[],
}));

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof planConversationModule>()),
  PlanConversation: vi.fn(() => conversationMock),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = (): void => {};

interface StubProcess {
  proc: ChildProcess;
  emitter: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: Mock };
}

function stubProcess(): StubProcess {
  const emitter = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: Mock };
  emitter.stdout = new EventEmitter();
  emitter.stderr = new EventEmitter();
  emitter.kill = vi.fn();
  // The planner only touches stdout/stderr/kill/close, so this stub stands in for a real ChildProcess.
  return { proc: emitter as unknown as ChildProcess, emitter };
}

function processWith(stdout: string): ChildProcess {
  const { proc, emitter } = stubProcess();
  queueMicrotask(() => {
    emitter.stdout.emit('data', Buffer.from(stdout));
    emitter.emit('close', 0);
  });
  return proc;
}

function mentionHandler(surface: SlackSurface): MockHandlerFn {
  const app = surface.getApp() as unknown as MockAppInternals;
  const found = app._eventHandlers.find((entry) => entry.pattern === 'app_mention');
  if (!found) throw new Error('Missing app_mention handler');
  return found.handler;
}

function recordingSay(): Mock {
  return vi.fn(async (message: SaidMessage) => {
    const ts = `say.${apiCalls.length}`;
    apiCalls.push({ method: 'postMessage', channel: 'C-test', text: message.text, ts });
    return { ts, ok: true };
  });
}

function baseConfig(): ConstructorParameters<typeof SlackSurface>[0] {
  return {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    signingSecret: 'test-secret',
    channelId: 'C-test',
    defaultRepoUrl: 'https://github.com/example/repo.git',
    useTypingIndicator: false,
    log: silentLog,
  };
}

describe('Slack thinking-placeholder repro contracts', () => {
  let surface: SlackSurface | undefined;

  beforeEach(() => {
    apiCalls.length = 0;
    mockSpawn.mockReset();
    conversationMock.sendMessage.mockReset();
    conversationMock.getDraftedPlan.mockReset();
    conversationMock.getDraftedPlan.mockReturnValue(null);
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (surface) await surface.stop();
    surface = undefined;
  });

  it('keeps the Processing ack visible until the question answer is posted', async () => {
    surface = new SlackSurface({
      ...baseConfig(),
      enableImmediateAck: true,
      planningHeartbeatIntervalSeconds: 0,
    });
    const reply = Promise.withResolvers<string>();
    conversationMock.sendMessage.mockReturnValue(reply.promise);

    await surface.start(async () => {});
    const say = recordingSay();
    const pendingMention = mentionHandler(surface)({
      event: { text: '<@UBOT> what does the retry queue do?', ts: '7777.001', user: 'U1', channel: 'C-test' },
      say,
    });

    await vi.waitFor(() => expect(conversationMock.sendMessage).toHaveBeenCalled());

    const ack = apiCalls.find((call) => call.method === 'postMessage' && call.text === 'Processing your request...');
    try {
      expect(ack).toBeDefined();
      // The planner is running: the placeholder must still be on screen.
      expect(apiCalls.some((call) => call.method === 'delete' && call.ts === ack?.ts)).toBe(false);
    } finally {
      reply.resolve('The retry queue re-runs failed tasks.');
      await pendingMention;
    }

    // The answer must be visible before (or at the moment) the ack disappears:
    // either the ack was updated in place with the answer, or the answer post
    // strictly precedes any deletion of the ack.
    const ackUpdatedWithAnswer = apiCalls.some((call) =>
      call.method === 'update' && call.ts === ack?.ts && call.text?.includes('retry queue re-runs failed tasks'));
    const answerIndex = apiCalls.findIndex((call) =>
      (call.method === 'postMessage' || call.method === 'update') && call.text?.includes('retry queue re-runs failed tasks'));
    const ackDeleteIndex = apiCalls.findIndex((call) => call.method === 'delete' && call.ts === ack?.ts);
    expect(
      ackUpdatedWithAnswer || (answerIndex !== -1 && (ackDeleteIndex === -1 || answerIndex < ackDeleteIndex)),
    ).toBe(true);
  });

  it('deletes Still thinking heartbeats only after the reply is posted', async () => {
    vi.useFakeTimers();
    surface = new SlackSurface({
      ...baseConfig(),
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 5,
    });

    const reply = Promise.withResolvers<string>();
    conversationMock.sendMessage.mockReturnValue(reply.promise);

    await surface.start(async () => {});

    const say = recordingSay();
    const pendingMention = mentionHandler(surface)({
      event: { text: '<@UBOT> plan: think hard about this', ts: '1000.001', user: 'U1', channel: 'C-test' },
      say,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const heartbeat = apiCalls.find((call) => call.text?.includes('Still thinking'));
    expect(heartbeat).toBeDefined();

    reply.resolve('Done!');
    await pendingMention;

    const replyIndex = apiCalls.findIndex((call) => call.method === 'postMessage' && call.text === 'Done!');
    const heartbeatDeleteIndex = apiCalls.findIndex((call) => call.method === 'delete' && call.ts === heartbeat?.ts);
    expect(replyIndex).toBeGreaterThan(-1);
    expect(heartbeatDeleteIndex).toBeGreaterThan(-1);
    expect(replyIndex).toBeLessThan(heartbeatDeleteIndex);
  });

  it('deletes heartbeats only after the error message is posted when the planner fails', async () => {
    vi.useFakeTimers();
    surface = new SlackSurface({
      ...baseConfig(),
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 5,
    });

    const reply = Promise.withResolvers<string>();
    conversationMock.sendMessage.mockReturnValue(reply.promise);

    await surface.start(async () => {});

    const say = recordingSay();
    const pendingMention = mentionHandler(surface)({
      event: { text: '<@UBOT> plan: this will fail', ts: '2000.001', user: 'U1', channel: 'C-test' },
      say,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    const heartbeat = apiCalls.find((call) => call.text?.includes('Still thinking'));
    expect(heartbeat).toBeDefined();

    reply.reject(new Error('Cursor CLI timeout'));
    await pendingMention;

    const errorIndex = apiCalls.findIndex((call) => call.method === 'postMessage' && call.text?.startsWith('Error:'));
    const heartbeatDeleteIndex = apiCalls.findIndex((call) => call.method === 'delete' && call.ts === heartbeat?.ts);
    expect(errorIndex).toBeGreaterThan(-1);
    expect(heartbeatDeleteIndex).toBeGreaterThan(-1);
    expect(errorIndex).toBeLessThan(heartbeatDeleteIndex);
  });
});

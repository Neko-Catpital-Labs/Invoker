import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SQLiteAdapter, SlackPlanDraftRepository, SlackSessionRepository } from '@invoker/data-store';
import { SlackSurface, DEFAULT_HARNESS_PRESET } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

// A bounded, seeded random ("monkey") pass over the Slack plan-intent flow —
// not to prove any one specific behavior (the targeted repro suites already
// do that), but to shake out anything a hand-written scenario didn't think
// to ask, by throwing randomized sequences of messages and button clicks at
// the real SlackSurface event handlers. Runs are seeded for reproducibility
// and bounded so this stays fast in CI, not a fuzzing framework.

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
    files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F_PLAN' }] }] }) },
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

// ── Tiny seeded PRNG (mulberry32) — no new dependency, reproducible runs ──

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

function processWith(stdout: string, beforeClose?: () => void): any {
  const process = new EventEmitter() as any;
  process.stdout = new EventEmitter();
  process.stderr = new EventEmitter();
  process.kill = vi.fn();
  queueMicrotask(() => {
    beforeClose?.();
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

function seedContext(slackSessionRepo: SlackSessionRepository, threadTs: string, workingDir: string): void {
  slackSessionRepo.saveLaunchContext({
    threadTs,
    repoUrl: 'https://github.com/EdbertChan/notarepo',
    harnessPreset: DEFAULT_HARNESS_PRESET,
    workingDir,
    requestedBy: 'U_TEST',
    lobbyChannelId: 'C_LOBBY',
    confirmationMode: 'require',
  });
}

function intentSignalPath(workingDir: string, threadTs: string): string {
  const safeId = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return join(workingDir, '.invoker', 'plan-intent', `${safeId}.json`);
}

const PLAIN_MESSAGES = [
  'why did so many fail',
  'for every issue create a repro script',
  'plan out how to fix this',
  'submit it',
  'convert this to Invoker',
  'actually never mind',
  'what does that mean',
] as const;

const GARBAGE_REPLIES = ['yes', 'no', 'ok', 'nope', 'ship it', 'asdkjfh', '', '   ', '/plan', '/plan fix the bug'] as const;

const RUN_COUNT = 30;
const STEPS_PER_RUN = 6;
const SEED = 424242;

describe('Slack plan-intent monkey pass', () => {
  let workingDir: string;
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let slackPlanDraftRepo: SlackPlanDraftRepository;
  let slackSessionRepo: SlackSessionRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    // A monkey run can't predict exactly which random actions will spawn a
    // planner (that depends on state built up by earlier random steps), so
    // give every call a safe fallback reply. Steps that care about a
    // specific reply (e.g. writing the intent signal) still layer a
    // mockImplementationOnce on top for that one call.
    mockSpawn.mockImplementation(() => processWith('monkey default reply'));
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-monkey-'));
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });
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
    rmSync(workingDir, { recursive: true, force: true });
  });

  it(`survives ${RUN_COUNT} randomized ${STEPS_PER_RUN}-step sequences without an unhandled error, an empty say(), or a runaway spawn loop`, async () => {
    const rng = mulberry32(SEED);
    const errors: unknown[] = [];
    const emptySayTexts: unknown[] = [];

    for (let run = 0; run < RUN_COUNT; run++) {
      const threadTs = `monkey-thread-${run}`;
      seedContext(slackSessionRepo, threadTs, workingDir);
      const say = vi.fn().mockImplementation((msg: { text?: unknown }) => {
        if (!msg?.text || (typeof msg.text === 'string' && msg.text.trim() === '')) {
          emptySayTexts.push({ run, msg });
        }
        return Promise.resolve({ ts: `posted-${run}` });
      });

      let lastApproveKey: string | undefined;
      let lastNoKey: string | undefined;
      const pendingCalls: Array<Promise<unknown>> = [];

      for (let step = 0; step < STEPS_PER_RUN; step++) {
        const writesSignal = rng() < 0.4;
        const action = pick(rng, [
          'mention_plain',
          'mention_bare_plan',
          'mention_plan_text',
          'bare_reply_garbage',
          'click_approve',
          'click_no',
          'click_stale',
        ] as const);

        const runStep = async (): Promise<void> => {
          const callsBefore = say.mock.calls.length;
          const isPlanCommand = (t: string) => /^\/plan\b/i.test(t.trim());
          let stepText: string | undefined;
          try {
            switch (action) {
              case 'mention_plain': {
                const text = pick(rng, PLAIN_MESSAGES);
                const path = intentSignalPath(workingDir, threadTs);
                mockSpawn.mockImplementationOnce(() => processWith(
                  'a normal reply',
                  writesSignal ? () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8') : undefined,
                ));
                await handler(surface, 'app_mention')({
                  event: { text: `<@UBOT> ${text}`, ts: `evt-${run}-${step}`, thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
                  say,
                });
                break;
              }
              case 'mention_bare_plan': {
                stepText = '/plan';
                await handler(surface, 'app_mention')({
                  event: { text: '<@UBOT> /plan', ts: `evt-${run}-${step}`, thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
                  say,
                });
                break;
              }
              case 'mention_plan_text': {
                stepText = '/plan add a REST endpoint';
                await handler(surface, 'app_mention')({
                  event: { text: '<@UBOT> /plan add a REST endpoint', ts: `evt-${run}-${step}`, thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
                  say,
                });
                break;
              }
              case 'bare_reply_garbage': {
                const text = pick(rng, GARBAGE_REPLIES);
                stepText = text;
                await handler(surface, 'message')({
                  event: { text, ts: `evt-${run}-${step}`, thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
                  say,
                });
                break;
              }
              case 'click_approve': {
                for (const [msg] of say.mock.calls) {
                  const button = msg.blocks?.[1]?.elements?.find((el: any) => el.action_id === 'lobby_plan_for_execution');
                  if (button?.value) lastApproveKey = button.value;
                }
                if (!lastApproveKey) return;
                mockSpawn.mockImplementationOnce(() => processWith('continuing'));
                await actionHandler(surface, 'lobby_plan_for_execution')({
                  action: { type: 'button', value: lastApproveKey },
                  body: { channel: { id: 'C_LOBBY' }, message: { ts: `posted-${run}`, thread_ts: threadTs } },
                  ack: vi.fn().mockResolvedValue(undefined),
                  respond: vi.fn().mockResolvedValue(undefined),
                });
                break;
              }
              case 'click_no': {
                for (const [msg] of say.mock.calls) {
                  const button = msg.blocks?.[1]?.elements?.find((el: any) => el.action_id === 'lobby_continue_conversation');
                  if (button?.value) lastNoKey = button.value;
                }
                if (!lastNoKey) return;
                mockSpawn.mockImplementationOnce(() => processWith('ok, continuing'));
                await actionHandler(surface, 'lobby_continue_conversation')({
                  action: { type: 'button', value: lastNoKey },
                  body: { channel: { id: 'C_LOBBY' }, message: { ts: `posted-${run}`, thread_ts: threadTs } },
                  ack: vi.fn().mockResolvedValue(undefined),
                  respond: vi.fn().mockResolvedValue(undefined),
                });
                break;
              }
              case 'click_stale': {
                // A key that was never staged — proves the "expired" path
                // never throws, regardless of what else is going on.
                await actionHandler(surface, 'lobby_plan_for_execution')({
                  action: { type: 'button', value: `stale-${run}-${step}` },
                  body: { channel: { id: 'C_LOBBY' }, message: { ts: `posted-${run}`, thread_ts: threadTs } },
                  ack: vi.fn().mockResolvedValue(undefined),
                  respond: vi.fn().mockResolvedValue(undefined),
                });
                break;
              }
            }
            // A message that is itself a /plan command must never resolve as
            // a failed yes/no confirmation — that's a routing bug (the
            // command got swallowed by an unrelated pending confirm instead
            // of being handled), not a crash, so it needs its own check.
            if (stepText && isPlanCommand(stepText)) {
              const newCalls = say.mock.calls.slice(callsBefore);
              const droppedApproval = newCalls.find(([msg]) =>
                typeof msg?.text === 'string' && msg.text.includes('Dropped the pending approval'));
              if (droppedApproval) {
                errors.push({ run, step, action, err: new Error(`"${stepText}" was swallowed by resolveConfirm's fallback instead of being routed as /plan`) });
              }
            }
          } catch (err) {
            errors.push({ run, step, action, err });
          }
        };

        // Occasionally fire this step without waiting for the previous one
        // to settle first, to exercise some real overlap.
        if (rng() < 0.25 && pendingCalls.length > 0) {
          pendingCalls.push(runStep());
        } else {
          await Promise.all(pendingCalls.splice(0));
          await runStep();
        }
      }
      await Promise.all(pendingCalls.splice(0));
    }

    expect(errors).toEqual([]);
    expect(emptySayTexts).toEqual([]);
    // Sanity bound: no run should have triggered a runaway spawn loop. Each
    // step spawns at most once (mention/plan/approve/no), so the ceiling is
    // generous on purpose — this is a smoke check, not a tight budget.
    expect(mockSpawn.mock.calls.length).toBeLessThan(RUN_COUNT * STEPS_PER_RUN * 2);
  });
});

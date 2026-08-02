import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SQLiteAdapter, SlackPlanDraftRepository, SlackSessionRepository } from '@invoker/data-store';
import { SlackSurface, DEFAULT_HARNESS_PRESET } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

// Replays the real Slack thread that motivated this feature: a long
// multi-turn investigation ("why did so many fail" -> repro scripts -> a
// fix-stack design), followed by "submit it" and later "convert this to
// Invoker". In the original incident, both of
// those got a reply that CLAIMED submission was being routed to a planner,
// and nothing happened. This proves the fixed thread: every investigative
// turn stays silent (no buttons, no drafting), and only a turn where the
// model actually signals intent produces the Approve/No buttons — using the
// user's literal message, not a summary of the whole conversation.

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

function tryButtonValue(say: ReturnType<typeof vi.fn>, actionId: string): string | undefined {
  for (const [message] of say.mock.calls) {
    for (const block of message.blocks ?? []) {
      const button = block.elements?.find((element: { action_id?: string }) => element.action_id === actionId);
      if (button?.value) return button.value;
    }
  }
  return undefined;
}

function buttonValue(say: ReturnType<typeof vi.fn>, actionId: string): string {
  const value = tryButtonValue(say, actionId);
  if (!value) throw new Error(`Missing ${actionId} button`);
  return value;
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

describe('Slack real-thread replay: the original "submit it" incident', () => {
  let workingDir: string;
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let slackPlanDraftRepo: SlackPlanDraftRepository;
  let slackSessionRepo: SlackSessionRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-real-thread-'));
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

  it('stays silent through a long investigation, then stages a plan on "submit it" using the literal message', async () => {
    const threadTs = 'real-thread-1';
    seedContext(slackSessionRepo, threadTs, workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });

    // Turn 1: "why did so many fail" — investigation, no plan ask. (The real
    // thread's opening "how are our workflows running" is a natural-language
    // status-query command, an entirely separate pre-existing code path —
    // not representative of an agent-mode conversational turn, so it's not
    // replayed here.)
    mockSpawn.mockImplementationOnce(() => processWith(
      'Not individual task bugs — it is a mass force-fail from app restarts...',
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> why did so many fail', ts: 't1', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    // Turn 2: asks to build repro scripts — still investigation, no plan ask.
    mockSpawn.mockImplementationOnce(() => processWith(
      'Built a runnable repro per issue — all 5 confirm.',
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> for every issue and crash create a repro script to prove you are correct', ts: 't2', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    // Turn 3: asks for a fix-stack design — this is a planning DISCUSSION,
    // not yet a submission ask, so it must not trigger the signal either.
    mockSpawn.mockImplementationOnce(() => processWith(
      'Here is the fix stack at a glance: S0 proof, S1 foundation, S2 behavior...',
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> plan out how to fix this with a stacked workflow for all these issues', ts: 't3', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    // None of the investigative/design turns should have staged anything.
    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(tryButtonValue(say, 'lobby_plan_for_execution')).toBeUndefined();
    expect(slackSessionRepo.getPendingConfirmation(threadTs)).toBeNull();

    // Turn 4: "submit it" — the exact phrase from the original incident.
    // This time the model recognizes it as a real ask and signals intent.
    const path = intentSignalPath(workingDir, threadTs);
    mockSpawn.mockImplementationOnce(() => processWith(
      'Got it — let me confirm before drafting anything.',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 't4', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    // Now — and only now — the real Approve/No buttons appear, and the
    // question is about the literal "submit it" message, not a paraphrase
    // of the whole prior conversation.
    expect(mockSpawn).toHaveBeenCalledTimes(4);
    const key = buttonValue(say, 'lobby_plan_for_execution');
    expect(buttonValue(say, 'lobby_continue_conversation')).toBeTruthy();
    const pending = slackSessionRepo.getPendingConfirmation(threadTs);
    expect(pending).not.toBeNull();
    expect((pending!.payload as { requestText?: string }).requestText).toBe('submit it');

    // Clicking Approve actually drafts a plan — the original incident's
    // missing half. It goes straight to drafting: "submit it" was already
    // sent to the model once (to detect the signal above), so Approve must
    // not ask it again — one more spawn call, not two.
    const plan = '```yaml\nname: "Stop counting SSH OAuth infra crashes"\nrepoUrl: "https://github.com/EdbertChan/notarepo"\ntasks:\n  - id: classify\n    description: "classify ssh-auth-expired as infra"\n    command: "pnpm test"\n    dependencies: []\n```';
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'msg', thread_ts: threadTs } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(mockSpawn).toHaveBeenCalledTimes(5);
    expect(commands).not.toContainEqual(expect.objectContaining({ type: 'start_plan' }));
    expect(slackPlanDraftRepo.getReady('C_LOBBY', threadTs)).toBeDefined();
  });

  it('also stages a plan for "convert this to Invoker" — the mechanism is not tied to one exact phrase', async () => {
    const threadTs = 'real-thread-2';
    seedContext(slackSessionRepo, threadTs, workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg' });

    const path = intentSignalPath(workingDir, threadTs);
    mockSpawn.mockImplementationOnce(() => processWith(
      'Got it — that is the planning request. Confirm before I draft anything.',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> convert this to Invoker', ts: 't1', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    const pending = slackSessionRepo.getPendingConfirmation(threadTs);
    expect((pending!.payload as { requestText?: string }).requestText).toBe('convert this to Invoker');
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SQLiteAdapter, SlackPlanDraftRepository, SlackSessionRepository } from '@invoker/data-store';
import { SlackSurface, DEFAULT_HARNESS_PRESET } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

// A plain-English request ("submit it") should never draft or submit a plan
// on its own. If the agent judges the request is itself a plan ask, it can
// only signal that by writing the plan-intent file this turn — the same
// Approve/No buttons the explicit /plan command already uses then appear.
// Prose alone (no file write) must never surface those buttons: that's the
// exact bug this feature replaces.

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

// A manually-controlled child: unlike processWith, nothing closes it
// automatically. Used to construct a specific interleaving deterministically
// rather than relying on timer race luck.
function controlledChild(): { proc: any; close: (stdout: string) => void } {
  const proc = new EventEmitter() as any;
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = vi.fn();
  return {
    proc,
    close: (stdout: string) => {
      proc.stdout.emit('data', Buffer.from(stdout));
      proc.emit('close', 0);
    },
  };
}

// How many internal awaits sit between an @mention landing and spawn()
// actually being invoked is an implementation detail. Rather than hand-count
// microtask ticks, flush them until the condition we actually care about
// is true.
async function flushUntil(predicate: () => boolean, maxTicks = 50): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await Promise.resolve();
  }
  throw new Error('condition never became true within maxTicks microtask flushes');
}

describe('Slack plan-intent auto-detect repro', () => {
  let workingDir: string;
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let slackPlanDraftRepo: SlackPlanDraftRepository;
  let slackSessionRepo: SlackSessionRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'plan-intent-auto-'));
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

  it('does not stage a plan question for a plain-English message with no intent file written', async () => {
    seedContext(slackSessionRepo, 'thread-1', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-1' });
    mockSpawn.mockImplementationOnce(() => processWith('Sure, want me to draft one for that?'));

    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 'thread-1', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(tryButtonValue(say, 'lobby_plan_for_execution')).toBeUndefined();
    expect(tryButtonValue(say, 'lobby_continue_conversation')).toBeUndefined();
  });

  it('stages the Approve/No plan question when the model writes the intent file', async () => {
    seedContext(slackSessionRepo, 'thread-2', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-2' });
    const path = intentSignalPath(workingDir, 'thread-2');
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });
    mockSpawn.mockImplementationOnce(() => processWith(
      'Sure, want me to draft one for that?',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));

    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 'thread-2', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(1);
    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    expect(buttonValue(say, 'lobby_continue_conversation')).toBeTruthy();
    expect(slackSessionRepo.getPendingConfirmation('thread-2')).not.toBeNull();
  });

  it('does not re-stage a second plan question when Approve replays the turn', async () => {
    seedContext(slackSessionRepo, 'thread-3', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-3' });
    const path = intentSignalPath(workingDir, 'thread-3');
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });
    mockSpawn.mockImplementationOnce(() => processWith(
      'Sure, want me to draft one for that?',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));
    await handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 'thread-3', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    const key = buttonValue(say, 'lobby_plan_for_execution');
    say.mockClear();
    mockSpawn.mockClear();

    const plan = '```yaml\nname: "Auto detect plan"\nrepoUrl: "https://github.com/EdbertChan/notarepo"\ntasks:\n  - id: t\n    description: "d"\n    command: "pnpm test"\n    dependencies: []\n```';
    mockSpawn.mockImplementationOnce(() => processWith(plan));
    await actionHandler(surface, 'lobby_plan_for_execution')({
      action: { type: 'button', value: key },
      body: { channel: { id: 'C_LOBBY' }, message: { ts: 'msg-3', thread_ts: 'thread-3' } },
      ack: vi.fn().mockResolvedValue(undefined),
      respond: vi.fn().mockResolvedValue(undefined),
    });

    expect(say).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('already a pending confirmation'),
    }));
    expect(tryButtonValue(say, 'lobby_plan_for_execution')).toBeUndefined();
    // The auto-detected turn already asked the model "submit it" once, before
    // staging. Approve must go straight to drafting, not replay it — exactly
    // one spawn call, not two.
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('does not lose the turn reply or crash the handler if staging the auto-detected confirm itself fails', async () => {
    seedContext(slackSessionRepo, 'thread-stage-fail', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-fail' });
    const path = intentSignalPath(workingDir, 'thread-stage-fail');
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });
    const stageError = new Error('sqlite write failed');
    const createSpy = vi.spyOn(slackSessionRepo, 'createPendingConfirmation').mockImplementationOnce(() => {
      throw stageError;
    });
    mockSpawn.mockImplementationOnce(() => processWith(
      'Sure, want me to draft one for that?',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));

    await expect(handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 'thread-stage-fail', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    })).resolves.not.toThrow();

    // The turn's real reply still went out.
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Sure, want me to draft one for that?'),
    }));
    // No confusing generic error message tacked on after it.
    expect(say).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('sqlite write failed'),
    }));
    createSpy.mockRestore();
  });

  it('a bare /plan reply takes priority over an unrelated pending confirm instead of being swallowed by it', async () => {
    seedContext(slackSessionRepo, 'thread-priority', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-p1' });

    // First /plan reply stages a pending plan_intent confirm.
    await handler(surface, 'message')({
      event: { text: '/plan add a REST endpoint', ts: 'msg-p1', thread_ts: 'thread-priority', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    expect(slackSessionRepo.getPendingConfirmation('thread-priority')).not.toBeNull();
    say.mockClear();

    // A second /plan reply, before the first is answered, must reach the
    // /plan handling (and get the "already pending" guard message) — not be
    // silently swallowed by resolveConfirm's "not a yes/no" fallback, which
    // would instead delete the pending confirm and say something unrelated.
    await handler(surface, 'message')({
      event: { text: '/plan actually add a different endpoint', ts: 'msg-p2', thread_ts: 'thread-priority', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(say).not.toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('Dropped the pending approval'),
    }));
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('already a pending confirmation'),
    }));
    // The original pending confirm must survive, not be dropped.
    expect(slackSessionRepo.getPendingConfirmation('thread-priority')).not.toBeNull();
  });

  it('skips detection for a bare in-thread reply with no pinned context yet', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg-4' });
    const path = intentSignalPath(workingDir, 'thread-4');
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });
    mockSpawn.mockImplementationOnce(() => processWith(
      'Sure thing.',
      () => writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8'),
    ));

    await handler(surface, 'message')({
      event: { text: 'local: submit it', ts: 'msg-4', thread_ts: 'thread-4', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(tryButtonValue(say, 'lobby_plan_for_execution')).toBeUndefined();
  });

  it('stages a plan question for a bare in-thread /plan reply, without re-mentioning the bot', async () => {
    seedContext(slackSessionRepo, 'thread-5', workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-5' });

    await handler(surface, 'message')({
      event: { text: '/plan add a REST endpoint', ts: 'msg-5', thread_ts: 'thread-5', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(mockSpawn).not.toHaveBeenCalled();
    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    expect(buttonValue(say, 'lobby_continue_conversation')).toBeTruthy();
  });

  it('tells the user to @mention first when a bare in-thread /plan has no pinned context', async () => {
    const say = vi.fn().mockResolvedValue({ ts: 'msg-6' });

    await handler(surface, 'message')({
      event: { text: '/plan add a REST endpoint', ts: 'msg-6', thread_ts: 'thread-6', user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    expect(tryButtonValue(say, 'lobby_plan_for_execution')).toBeUndefined();
    expect(say).toHaveBeenCalledWith(expect.objectContaining({
      text: expect.stringContaining('@mention me first'),
    }));
  });

  it('does not let a second concurrent @mention on the same thread wipe the first turn\'s signal before it is read', async () => {
    const threadTs = 'thread-race';
    seedContext(slackSessionRepo, threadTs, workingDir);
    const say = vi.fn().mockResolvedValue({ ts: 'msg-race' });
    const path = intentSignalPath(workingDir, threadTs);
    mkdirSync(join(workingDir, '.invoker', 'plan-intent'), { recursive: true });

    const a = controlledChild();
    const b = controlledChild();
    mockSpawn.mockImplementationOnce(() => a.proc);
    mockSpawn.mockImplementationOnce(() => b.proc);

    // First Slack event for this thread: "submit it".
    const replyA = handler(surface, 'app_mention')({
      event: { text: '<@UBOT> submit it', ts: 'evt-a', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });
    await flushUntil(() => mockSpawn.mock.calls.length >= 1);

    // A's model "writes its file" mid-turn (process is still open).
    writeFileSync(path, JSON.stringify({ wantsPlan: true }), 'utf8');

    // A second Slack event for the SAME thread arrives before the first has
    // finished — e.g. the user sent two messages in quick succession.
    const replyB = handler(surface, 'app_mention')({
      event: { text: '<@UBOT> actually never mind', ts: 'evt-b', thread_ts: threadTs, user: 'U_TEST', channel: 'C_LOBBY' },
      say,
    });

    a.close('sure, want me to draft one for that?');
    await replyA;

    await flushUntil(() => mockSpawn.mock.calls.length >= 2);
    b.close('ok, no plan then');
    await replyB;

    // The first turn's real signal must have produced the Approve/No
    // buttons, keyed to its own request text — not lost to the second,
    // concurrently-arriving turn's setup.
    expect(buttonValue(say, 'lobby_plan_for_execution')).toBeTruthy();
    const pending = slackSessionRepo.getPendingConfirmation(threadTs);
    expect(pending).not.toBeNull();
    expect((pending!.payload as { requestText?: string }).requestText).toBe('submit it');
  });
});

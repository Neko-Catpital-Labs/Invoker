// E2E regression coverage for the 2026-08-05 Slack same-channel
// cross-thread contamination outage. This drives the production path through
// SlackSurface -> SessionManager -> PlanConversation -> ConversationRepository,
// mocking only Slack transport and the planner subprocess.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SQLiteAdapter, SlackSessionRepository } from '@invoker/data-store';
import { SlackSurface, DEFAULT_HARNESS_PRESET } from '../slack/slack-surface.js';
import type { SurfaceCommand } from '../surface.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

vi.mock('@slack/bolt', () => {
  class MockApp {
    _commandHandlers: MockHandler[] = [];
    _actionHandlers: MockHandler[] = [];
    _eventHandlers: MockHandler[] = [];
    command = vi.fn((name: string, handler: Function) => {
      this._commandHandlers.push({ pattern: name, handler });
    });
    action = vi.fn((pattern: string | RegExp, handler: Function) => {
      this._actionHandlers.push({ pattern, handler });
    });
    event = vi.fn((pattern: string, handler: Function) => {
      this._eventHandlers.push({ pattern, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT' }) },
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: 'posted' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue({}),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }),
      },
      reactions: {
        add: vi.fn().mockResolvedValue({}),
        remove: vi.fn().mockResolvedValue({}),
      },
    };
  }
  return { App: MockApp };
});

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof childProcess>()),
  spawn: vi.fn(),
}));

const mockSpawn = vi.mocked(childProcess.spawn);
const silentLog = () => {};

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

function mentionHandler(surface: SlackSurface): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: MockHandler) => entry.pattern === 'app_mention');
  if (!found) throw new Error('app_mention handler not registered');
  return found.handler;
}

function spawnedPrompt(callIndex: number): string {
  const args = mockSpawn.mock.calls[callIndex]?.[1] as string[] | undefined;
  if (!args) throw new Error(`Missing spawn call ${callIndex}`);
  return args[args.length - 1];
}

function spawnedCwd(callIndex: number): string {
  const opts = mockSpawn.mock.calls[callIndex]?.[2] as { cwd?: string } | undefined;
  if (!opts?.cwd) throw new Error(`Missing spawn cwd ${callIndex}`);
  return opts.cwd;
}

function seedLaunchContext(repo: SlackSessionRepository, input: {
  threadTs: string;
  workingDir: string;
  requestedBy: string;
  channelId: string;
}): void {
  repo.saveLaunchContext({
    threadTs: input.threadTs,
    repoUrl: 'https://github.com/example/repo.git',
    harnessPreset: DEFAULT_HARNESS_PRESET,
    workingDir: input.workingDir,
    requestedBy: input.requestedBy,
    lobbyChannelId: input.channelId,
    confirmationMode: 'require',
  });
}

describe('E2E: Slack same-channel interleaving cannot swap persisted conversation history', () => {
  const channelId = 'C-INCIDENTS';
  const threadA = '1785890604.484199';
  const threadB = '1785890283.654509';
  const poisonFromOtherThread = 'POISON silent-catch docs scope from another Slack thread';

  let rootDir: string;
  let workingDirA: string;
  let workingDirB: string;
  let adapter: SQLiteAdapter;
  let conversationRepo: ConversationRepository;
  let slackSessionRepo: SlackSessionRepository;
  let surface: SlackSurface;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    mockSpawn.mockImplementation((_command: string, args: string[]) => {
      const prompt = args[args.length - 1] ?? '';
      if (prompt.includes('A_TURN_2 four approval answers')) return processWith('A_REPLY_2 close-empty-PRs stays local');
      if (prompt.includes('A_TURN_1 CodeRabbit audit scope')) return processWith('A_REPLY_1 CodeRabbit audit stays local');
      if (prompt.includes('B_TURN_1 repo-context-default scope')) return processWith('B_REPLY_1 repo-context-default stays local');
      return processWith('unexpected prompt');
    });

    rootDir = mkdtempSync(join(tmpdir(), 'slack-thread-interleaving-'));
    workingDirA = join(rootDir, 'thread-a-session');
    workingDirB = join(rootDir, 'thread-b-session');
    mkdirSync(workingDirA, { recursive: true });
    mkdirSync(workingDirB, { recursive: true });

    adapter = await SQLiteAdapter.create(':memory:');
    conversationRepo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    slackSessionRepo = new SlackSessionRepository(adapter);
    commands = [];

    seedLaunchContext(slackSessionRepo, {
      threadTs: threadA,
      workingDir: workingDirA,
      requestedBy: 'U_A',
      channelId,
    });
    seedLaunchContext(slackSessionRepo, {
      threadTs: threadB,
      workingDir: workingDirB,
      requestedBy: 'U_B',
      channelId,
    });

    conversationRepo.saveConversation(
      threadA,
      [
        { role: 'user', content: poisonFromOtherThread },
        { role: 'assistant', content: 'POISON assistant denial of a different thread YAML draft' },
      ],
      null,
      false,
      // Legacy pre-fix row shape: first writer omitted channelId, so it stored ''.
    );
    expect(conversationRepo.loadConversation(threadA)?.channelId).toBe('');

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId,
      lobbyChannelId: channelId,
      defaultRepoUrl: 'https://github.com/example/repo.git',
      conversationRepo,
      slackSessionRepo,
      cursorCommand: 'cursor',
      conversationalPlanning: true,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
    });
    await surface.start(async (command) => { commands.push(command); });
  });

  afterEach(async () => {
    await surface.stop();
    adapter.close();
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('keeps interleaved same-channel threads isolated despite a legacy empty-channelId row', async () => {
    const handleMention = mentionHandler(surface);
    const say = vi.fn().mockResolvedValue({ ts: 'reply-ts' });

    await handleMention({
      event: {
        text: '<@UBOT> A_TURN_1 CodeRabbit audit scope',
        ts: threadA,
        user: 'U_A',
        channel: channelId,
      },
      say,
    });
    await handleMention({
      event: {
        text: '<@UBOT> B_TURN_1 repo-context-default scope',
        ts: threadB,
        user: 'U_B',
        channel: channelId,
      },
      say,
    });
    await handleMention({
      event: {
        text: '<@UBOT> A_TURN_2 four approval answers',
        ts: '1785890604.999999',
        thread_ts: threadA,
        user: 'U_A',
        channel: channelId,
      },
      say,
    });

    expect(mockSpawn).toHaveBeenCalledTimes(3);
    expect(spawnedCwd(0)).toBe(workingDirA);
    expect(spawnedCwd(1)).toBe(workingDirB);
    expect(spawnedCwd(2)).toBe(workingDirA);

    const promptA1 = spawnedPrompt(0);
    const promptB1 = spawnedPrompt(1);
    const promptA2 = spawnedPrompt(2);

    expect(promptA1).toContain('A_TURN_1 CodeRabbit audit scope');
    expect(promptA1).not.toContain(poisonFromOtherThread);
    expect(promptA1).not.toContain('B_TURN_1 repo-context-default scope');

    expect(promptB1).toContain('B_TURN_1 repo-context-default scope');
    expect(promptB1).not.toContain(poisonFromOtherThread);
    expect(promptB1).not.toContain('A_TURN_1 CodeRabbit audit scope');

    expect(promptA2).toContain('A_TURN_1 CodeRabbit audit scope');
    expect(promptA2).toContain('A_REPLY_1 CodeRabbit audit stays local');
    expect(promptA2).toContain('A_TURN_2 four approval answers');
    expect(promptA2).not.toContain(poisonFromOtherThread);
    expect(promptA2).not.toContain('B_TURN_1 repo-context-default scope');
    expect(promptA2).not.toContain('B_REPLY_1 repo-context-default stays local');

    expect(say).toHaveBeenCalledTimes(3);
    expect(say.mock.calls.map(([message]) => message.thread_ts)).toEqual([threadA, threadB, threadA]);
    expect(say.mock.calls.map(([message]) => message.text)).toEqual([
      'A_REPLY_1 CodeRabbit audit stays local',
      'B_REPLY_1 repo-context-default stays local',
      'A_REPLY_2 close-empty-PRs stays local',
    ]);
    expect(commands).toEqual([]);
  });
});

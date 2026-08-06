// E2E regression coverage for the 2026-08-05 Slack cross-thread contamination
// outage shape: same channel, interleaved persisted planning threads, and a
// legacy conversation row whose stored channelId is empty.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConversationRepository, SQLiteAdapter } from '@invoker/data-store';
import type { HarnessSessionDriver } from '@invoker/execution-engine';
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
    files: { uploadV2: vi.fn().mockResolvedValue({ ok: true, files: [{ ok: true, files: [{ id: 'F1' }] }] }) },
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
  ...(await importOriginal<typeof import('node:child_process')>()),
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

function getMentionHandler(surface: SlackSurface): Function {
  const found = (surface.getApp() as any)._eventHandlers.find((entry: MockHandler) => entry.pattern === 'app_mention');
  if (!found) throw new Error('app_mention handler not registered');
  return found.handler;
}

function recordingHarnessDriver(prompts: Array<{ kind: 'start' | 'append'; sessionId: string; prompt: string }>): HarnessSessionDriver {
  let nextSession = 0;
  return {
    harness: 'recording-harness',
    supportsSessionContinuity: false,
    start: (prompt: string) => {
      const sessionId = `recording-session-${++nextSession}`;
      prompts.push({ kind: 'start', sessionId, prompt });
      return { command: 'agent', args: ['--print', prompt], sessionId };
    },
    append: (_sessionId: string, prompt: string) => {
      const sessionId = `recording-session-${++nextSession}`;
      prompts.push({ kind: 'append', sessionId, prompt });
      return { command: 'agent', args: ['--print', prompt], sessionId };
    },
  };
}

describe('E2E: Slack same-channel interleaving contamination regression', () => {
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let workingDir: string;
  let surface: SlackSurface;
  let prompts: Array<{ kind: 'start' | 'append'; sessionId: string; prompt: string }>;
  let commands: SurfaceCommand[];

  beforeEach(async () => {
    mockSpawn.mockReset();
    mockSpawn.mockImplementation(() => processWith('acknowledged'));
    sharedSlack.client.auth.test.mockClear();
    sharedSlack.client.chat.postMessage.mockClear();
    sharedSlack.client.chat.update.mockClear();
    sharedSlack.client.chat.delete.mockClear();
    sharedSlack.client.files.uploadV2.mockClear();

    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter, { info: silentLog, warn: silentLog, error: silentLog });
    workingDir = mkdtempSync(join(tmpdir(), 'slack-thread-interleaving-'));
    prompts = [];
    commands = [];
  });

  afterEach(async () => {
    await surface?.stop();
    adapter.close();
    rmSync(workingDir, { recursive: true, force: true });
  });

  async function startSurface(): Promise<void> {
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-SAME-CHANNEL',
      lobbyChannelId: 'C-SAME-CHANNEL',
      defaultRepoUrl: 'https://github.com/example/repo.git',
      workingDir,
      conversationRepo: repo,
      enableImmediateAck: false,
      planningHeartbeatIntervalSeconds: 0,
      log: silentLog,
      harnessPresets: { recording: { tool: 'recording-harness' } },
      defaultHarnessPreset: 'recording',
      harnessSessionDriverFactory: () => recordingHarnessDriver(prompts),
    });
    await surface.start(async (command) => { commands.push(command); });
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function mention(text: string, ts: string, threadTs?: string) {
    const say = vi.fn().mockResolvedValue({ ts: `${ts}-reply` });
    await getMentionHandler(surface)({
      event: {
        text: `<@UBOT> ${text}`,
        ts,
        thread_ts: threadTs,
        user: 'U_PROOF',
        channel: 'C-SAME-CHANNEL',
      },
      say,
    });
    return say;
  }

  it('keeps two same-channel persisted threads isolated across interleaved turns despite an empty-channelId legacy row', async () => {
    repo.saveConversation(
      'thread-A',
      [
        { role: 'user', content: 'LEGACY silent-catch scope from a different Slack thread' },
        { role: 'assistant', content: 'LEGACY unrelated YAML draft denial' },
      ],
      null,
      false,
    );
    expect(repo.loadConversation('thread-A')?.channelId).toBe('');

    await startSurface();

    const sayA1 = await mention('A asks about CodeRabbit audit planning', 'thread-A');
    const sayB1 = await mention('B asks about Slack-bot-icon scope', 'thread-B');
    const sayA2 = await mention('A follow-up: keep this on CodeRabbit only', 'thread-A-turn-2', 'thread-A');

    expect(sayA1).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: 'thread-A' }));
    expect(sayB1).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: 'thread-B' }));
    expect(sayA2).toHaveBeenCalledWith(expect.objectContaining({ thread_ts: 'thread-A' }));

    expect(prompts).toHaveLength(3);
    const [aFirst, bFirst, aSecond] = prompts;

    expect(aFirst.prompt).toContain('A asks about CodeRabbit audit planning');
    expect(aFirst.prompt).not.toContain('LEGACY silent-catch scope');
    expect(aFirst.prompt).not.toContain('LEGACY unrelated YAML draft denial');
    expect(aFirst.prompt).not.toContain('Slack-bot-icon scope');

    expect(bFirst.prompt).toContain('B asks about Slack-bot-icon scope');
    expect(bFirst.prompt).not.toContain('CodeRabbit audit planning');
    expect(bFirst.prompt).not.toContain('LEGACY silent-catch scope');

    expect(aSecond.prompt).toContain('A asks about CodeRabbit audit planning');
    expect(aSecond.prompt).toContain('A follow-up: keep this on CodeRabbit only');
    expect(aSecond.prompt).toContain('acknowledged');
    expect(aSecond.prompt).not.toContain('B asks about Slack-bot-icon scope');
    expect(aSecond.prompt).not.toContain('LEGACY silent-catch scope');

    const threadA = repo.loadConversation('thread-A');
    const threadB = repo.loadConversation('thread-B');
    expect(threadA).not.toBeNull();
    expect(threadB).not.toBeNull();
    // The legacy row itself remains an old append-only persistence artifact;
    // the regression property here is that it is not loaded into the live
    // PlanConversation prompt and does not pick up thread B's history.
    expect(JSON.stringify(threadA!.messages)).toContain('A follow-up: keep this on CodeRabbit only');
    expect(JSON.stringify(threadA!.messages)).not.toContain('Slack-bot-icon scope');
    expect(JSON.stringify(threadB!.messages)).toContain('Slack-bot-icon scope');
    expect(JSON.stringify(threadB!.messages)).not.toContain('CodeRabbit audit planning');
  });
});

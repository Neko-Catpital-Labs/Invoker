// E2E regression coverage for the Slack cross-conversation bleed bug:
// https://github.com/Neko-Catpital-Labs/Invoker/pull/7514
// https://github.com/Neko-Catpital-Labs/Invoker/pull/7515
//
// Unlike slack-thread-isolation.test.ts, this file does NOT mock PlanConversation.
// It drives the real production path — SlackSurface's mention handler ->
// SessionManager -> PlanConversation -> ConversationRepository -> SQLiteAdapter —
// with only the Slack transport (@slack/bolt) and the CLI subprocess
// (node:child_process.spawn) faked out. That is the only way to exercise the
// exact write path (PlanConversation.saveState()) and read path
// (SessionManager.getOrCreateSession()) that the bug lived in.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as child_process from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackSurface } from '../slack/slack-surface.js';
import { SQLiteAdapter, ConversationRepository } from '@invoker/data-store';
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
    event = vi.fn((name: string, handler: Function) => {
      this._eventHandlers.push({ pattern: name, handler });
    });
    start = vi.fn().mockResolvedValue(undefined);
    stop = vi.fn().mockResolvedValue(undefined);
    client = {
      chat: {
        postMessage: vi.fn().mockResolvedValue({ ts: '1234567890.123456' }),
        update: vi.fn().mockResolvedValue({}),
      },
      auth: {
        test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }),
      },
      files: {
        uploadV2: vi.fn().mockResolvedValue({ files: [{ id: 'F1' }] }),
      },
    };
  }
  return { App: MockApp };
});

// Fake the CLI subprocess only — everything above it (PlanConversation,
// SessionManager, ConversationRepository, SQLiteAdapter) is the real thing.
// The mocked reply echoes back a per-channel-recognizable string derived
// from stdin-equivalent args so a test can prove which channel's prompt
// a given spawn call belongs to, if ever needed for debugging.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    spawn: vi.fn((_command: string, _args: string[]) => {
      const { EventEmitter } = require('node:events');
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = vi.fn();
      setTimeout(() => {
        proc.stdout.emit('data', Buffer.from('acknowledged'));
        proc.emit('close', 0);
      }, 0);
      return proc;
    }),
  };
});

const mockSpawn = vi.mocked(child_process.spawn);

function getMentionHandler(surface: SlackSurface): Function {
  const app = surface.getApp() as any;
  const handler = app._eventHandlers.find((h: MockHandler) => h.pattern === 'app_mention')?.handler;
  if (!handler) throw new Error('app_mention handler not registered');
  return handler;
}

const flushAsync = () => new Promise<void>((r) => setTimeout(r, 0));

describe('E2E: real SlackSurface + real persistence — multi-channel isolation', () => {
  let workingDir: string;
  let adapter: SQLiteAdapter;
  let repo: ConversationRepository;
  let surface: SlackSurface;
  let receivedCommands: SurfaceCommand[];

  beforeEach(async () => {
    workingDir = mkdtempSync(join(tmpdir(), 'slack-multi-thread-e2e-'));
    adapter = await SQLiteAdapter.create(':memory:');
    repo = new ConversationRepository(adapter);
    receivedCommands = [];
    surface = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      workingDir,
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-BOT-DEFAULT-HOME',
      cursorCommand: 'cursor',
      conversationRepo: repo,
    });
    await surface.start(async (cmd) => { receivedCommands.push(cmd); });
  });

  afterEach(() => {
    adapter.close();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('keeps two real, unrelated channels fully isolated across several interleaved turns each', async () => {
    const mentionHandler = getMentionHandler(surface);
    const say = vi.fn();

    // Mirrors the reported incident: one channel discussing closing empty
    // PRs, a completely different channel discussing a silent-catch lint
    // policy — messages interleaved turn by turn, same bot process.
    await mentionHandler({
      event: { text: '<@U_BOT> close all PRs that are empty changes', ts: 'prs-1', thread_ts: undefined, user: 'U-CHIEF-CAT-OFFICER', channel: 'C-CLOSE-EMPTY-PRS' },
      say,
    });
    await mentionHandler({
      event: { text: '<@U_BOT> add real enforcement for silent catch blocks', ts: 'lint-1', thread_ts: undefined, user: 'U-OTHER-DEV', channel: 'C-LINT-POLICY' },
      say,
    });
    await mentionHandler({
      event: { text: '<@U_BOT> 1. Yes 2. Skip 3. Ignore the stacked ones 4. Do not delete', ts: 'prs-2', thread_ts: 'prs-1', user: 'U-CHIEF-CAT-OFFICER', channel: 'C-CLOSE-EMPTY-PRS' },
      say,
    });
    await mentionHandler({
      event: { text: '<@U_BOT> 1a, severity must match', ts: 'lint-2', thread_ts: 'lint-1', user: 'U-OTHER-DEV', channel: 'C-LINT-POLICY' },
      say,
    });

    const prsConversation = repo.loadConversation('prs-1');
    const lintConversation = repo.loadConversation('lint-1');

    expect(prsConversation).not.toBeNull();
    expect(lintConversation).not.toBeNull();

    // Each row is persisted with its own real, non-empty channelId.
    expect(prsConversation!.channelId).toBe('C-CLOSE-EMPTY-PRS');
    expect(lintConversation!.channelId).toBe('C-LINT-POLICY');

    // No cross-contamination: the "close PRs" thread's transcript never
    // contains the lint conversation's text, and vice versa.
    const prsText = JSON.stringify(prsConversation!.messages);
    const lintText = JSON.stringify(lintConversation!.messages);
    expect(prsText).toContain('close all PRs');
    expect(prsText).not.toContain('silent catch');
    expect(lintText).toContain('silent catch');
    expect(lintText).not.toContain('close all PRs');
  });

  it('does not let a bot restart hand a fresh channel an old, differently-channeled conversation history', async () => {
    // Simulate a leftover row from before the fix landed: PlanConversation
    // .saveState() used to persist channelId='' whenever it was a thread's
    // first writer. Reproduce that exact poisoned shape directly against
    // the same database this SlackSurface instance uses.
    const POISONED_THREAD_TS = 'poisoned-thread-1785890000';
    repo.saveConversation(
      POISONED_THREAD_TS,
      [
        { role: 'user', content: 'unrelated pre-fix conversation content that should never resurface' },
        { role: 'assistant', content: 'a reply that belongs to nobody\'s current channel' },
      ],
      null,
      false,
      // channelId omitted on purpose, matching the historical bug shape.
    );
    expect(repo.loadConversation(POISONED_THREAD_TS)?.channelId).toBe('');

    // Simulate a bot restart: a brand-new SlackSurface instance backed by
    // the same persisted database recovers active conversations, exactly
    // as production does after a redeploy.
    await surface.stop();
    const restarted = new SlackSurface({
      defaultRepoUrl: 'https://github.com/example/repo.git',
      workingDir,
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-BOT-DEFAULT-HOME',
      cursorCommand: 'cursor',
      conversationRepo: repo,
    });
    await restarted.start(async (cmd) => { receivedCommands.push(cmd); });
    await flushAsync(); // let background recoverActiveConversations() settle

    // A brand-new, unrelated channel now happens to reply into that exact
    // poisoned thread id (recoverActiveConversations bucketed the orphaned
    // row under this bot's own default channel — the historical trigger).
    mockSpawn.mockClear();
    const mentionHandler = getMentionHandler(restarted);
    const say = vi.fn();
    await mentionHandler({
      event: { text: '<@U_BOT> what is this thread about?', ts: 'followup-1', thread_ts: POISONED_THREAD_TS, user: 'U-SOMEONE-NEW', channel: 'C-BOT-DEFAULT-HOME' },
      say,
    });

    // The security property that matters: the orphaned conversation's
    // content must never reach the LLM prompt for this new, unrelated
    // channel's turn — i.e. it must never be spawned as part of the CLI
    // invocation's args (which embed the full prompt, history included).
    expect(mockSpawn).toHaveBeenCalledTimes(1);
    const spawnedArgs = mockSpawn.mock.calls[0][1] as string[];
    const spawnedCommandText = spawnedArgs.join(' ');
    expect(spawnedCommandText).not.toContain('unrelated pre-fix conversation content');
    expect(spawnedCommandText).not.toContain('a reply that belongs to nobody');
    expect(spawnedCommandText).toContain('what is this thread about?');

    await restarted.stop();
  });
});

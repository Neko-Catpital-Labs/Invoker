import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SlackSurface } from '../slack/slack-surface.js';

interface MockHandler {
  pattern: string | RegExp;
  handler: Function;
}

const uploadV2 = vi.fn().mockResolvedValue({ ok: true });
const posted: { text?: string; thread_ts?: string }[] = [];

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
        postMessage: vi.fn().mockImplementation(async ({ text, thread_ts }) => {
          posted.push({ text, thread_ts });
          return { ts: '111.222', ok: true };
        }),
        update: vi.fn().mockResolvedValue({ ok: true }),
        delete: vi.fn().mockResolvedValue({ ok: true }),
      },
      auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT123456' }) },
      reactions: {
        add: vi.fn().mockResolvedValue({ ok: true }),
        remove: vi.fn().mockResolvedValue({ ok: true }),
      },
      files: { uploadV2 },
    };
  }
  return { App: MockApp };
});

const mockSendMessage = vi.fn();
let workingDir: string;
const mockPlanConversation = {
  sendMessage: mockSendMessage,
  getDraftedPlan: () => null,
  submittedPlanText: null as any,
  planSubmitted: false,
  conversationMode: 'agent' as const,
  init: vi.fn().mockResolvedValue(undefined),
  get workingDir() {
    return workingDir;
  },
};

vi.mock('../slack/plan-conversation.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../slack/plan-conversation.js')>()),
  PlanConversation: vi.fn(() => mockPlanConversation),
}));

async function replyWith(surface: SlackSurface, reply: string): Promise<void> {
  mockSendMessage.mockResolvedValue(reply);
  const app = surface.getApp() as any;
  const mentionHandler = app._eventHandlers.find(
    (h: MockHandler) => h.pattern === 'app_mention',
  )?.handler;
  await mentionHandler({
    event: {
      text: '<@UBOT123456> show me the mockups',
      ts: '1234567890.123456',
      thread_ts: undefined,
      user: 'U123',
      channel: 'C-test',
    },
    say: vi.fn().mockResolvedValue({ ts: '999.888', ok: true }),
  });
}

describe('SlackSurface artifact upload', () => {
  let surface: SlackSurface;

  beforeEach(() => {
    uploadV2.mockClear();
    uploadV2.mockResolvedValue({ ok: true });
    posted.length = 0;
    mockSendMessage.mockReset();
    workingDir = mkdtempSync(join(tmpdir(), 'slack-artifact-'));
    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: 'C-test',
      anthropicApiKey: 'test-anthropic-key',
    });
  });

  afterEach(async () => {
    if (surface) await surface.stop();
    rmSync(workingDir, { recursive: true, force: true });
  });

  it('uploads a linked artifact into the same thread', async () => {
    const png = join(workingDir, 'inbox.png');
    writeFileSync(png, 'not-really-a-png');

    await surface.start(async () => {});
    await replyWith(surface, `Here you go: [inbox](${png})`);

    expect(uploadV2).toHaveBeenCalledTimes(1);
    const call = uploadV2.mock.calls[0][0];
    expect(call.channel_id).toBe('C-test');
    expect(call.thread_ts).toBe('1234567890.123456');
    expect(call.file_uploads).toEqual([{ file: png, filename: 'inbox.png' }]);
  });

  it('uploads a repeated link only once', async () => {
    const png = join(workingDir, 'a.png');
    writeFileSync(png, 'x');

    await surface.start(async () => {});
    await replyWith(surface, `[a](${png}) and again [a](${png})`);

    expect(uploadV2.mock.calls[0][0].file_uploads).toHaveLength(1);
  });

  it('does not upload a path outside the worktree', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'slack-outside-'));
    const secret = join(outside, 'id_rsa');
    writeFileSync(secret, 'PRIVATE KEY');

    await surface.start(async () => {});
    await replyWith(surface, `[key](${secret})`);

    expect(uploadV2).not.toHaveBeenCalled();
    rmSync(outside, { recursive: true, force: true });
  });

  it('does not upload when the reply links nothing', async () => {
    await surface.start(async () => {});
    await replyWith(surface, 'No files this time, just an Invoker plan summary.');
    expect(uploadV2).not.toHaveBeenCalled();
  });

  it('skips directories and unreadable paths without calling Slack', async () => {
    mkdirSync(join(workingDir, 'artifacts'));
    await surface.start(async () => {});
    await replyWith(
      surface,
      `[dir](${join(workingDir, 'artifacts')}) [missing](${join(workingDir, 'nope.png')})`,
    );
    expect(uploadV2).not.toHaveBeenCalled();
  });

  it('surfaces an upload failure in the thread instead of swallowing it', async () => {
    const png = join(workingDir, 'a.png');
    writeFileSync(png, 'x');
    uploadV2.mockRejectedValue(new Error('missing_scope'));

    await surface.start(async () => {});
    await replyWith(surface, `[a](${png})`);

    const failure = posted.find((p) => p.text?.includes('missing_scope'));
    expect(failure).toBeDefined();
    expect(failure?.thread_ts).toBe('1234567890.123456');
  });
});

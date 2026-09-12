import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  usersConversations: vi.fn(),
  conversationsInfo: vi.fn(),
  conversationsHistory: vi.fn(),
  conversationsReplies: vi.fn(),
  chatPostMessage: vi.fn(),
  webClientCtor: vi.fn(),
}));

vi.mock('@slack/web-api', () => ({
  WebClient: class {
    users = { conversations: mocks.usersConversations };
    conversations = { info: mocks.conversationsInfo, history: mocks.conversationsHistory, replies: mocks.conversationsReplies };
    chat = { postMessage: mocks.chatPostMessage };
    constructor(token: string) {
      mocks.webClientCtor(token);
    }
  },
}));

const { createRealSlackBugScanClient } = await import('../real-client.js');

function envWithoutSlackToken(): NodeJS.ProcessEnv {
  return { ...process.env, SLACK_BOT_TOKEN: undefined, INVOKER_SLACK_OWNER_ENV: '/nonexistent/.env' };
}

describe('createRealSlackBugScanClient token resolution', () => {
  it('returns undefined when no token is configured anywhere', () => {
    expect(createRealSlackBugScanClient(envWithoutSlackToken())).toBeUndefined();
  });

  it('returns a client when SLACK_BOT_TOKEN is set', () => {
    const client = createRealSlackBugScanClient({ ...process.env, SLACK_BOT_TOKEN: 'xoxb-test' });
    expect(client).toBeDefined();
    expect(mocks.webClientCtor).toHaveBeenCalledWith('xoxb-test');
  });

  it('falls back to reading SLACK_BOT_TOKEN from the configured env file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'slack-bug-scan-env-'));
    const envFile = path.join(dir, '.env');
    writeFileSync(envFile, 'SLACK_BOT_TOKEN=xoxb-from-file\nOTHER=1\n');
    try {
      const client = createRealSlackBugScanClient({
        ...process.env,
        SLACK_BOT_TOKEN: undefined,
        INVOKER_SLACK_OWNER_ENV: envFile,
      });
      expect(client).toBeDefined();
      expect(mocks.webClientCtor).toHaveBeenCalledWith('xoxb-from-file');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('createRealSlackBugScanClient behavior', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeClient() {
    return createRealSlackBugScanClient({ ...process.env, SLACK_BOT_TOKEN: 'xoxb-test' })!;
  }

  it('listMemberChannels pages through users.conversations and hydrates topic/purpose per channel', async () => {
    mocks.usersConversations
      .mockResolvedValueOnce({
        channels: [{ id: 'C1', name: 'general' }],
        response_metadata: { next_cursor: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        channels: [{ id: 'C2', name: 'random' }],
        response_metadata: { next_cursor: '' },
      });
    mocks.conversationsInfo.mockImplementation(async ({ channel }: { channel: string }) => ({
      channel: { topic: { value: `topic-${channel}` }, purpose: { value: `purpose-${channel}` } },
    }));

    const channels = await makeClient().listMemberChannels();

    expect(mocks.usersConversations).toHaveBeenCalledTimes(2);
    expect(channels).toEqual([
      { id: 'C1', name: 'general', topic: 'topic-C1', purpose: 'purpose-C1' },
      { id: 'C2', name: 'random', topic: 'topic-C2', purpose: 'purpose-C2' },
    ]);
  });

  it('listHistorySince pages through conversations.history and maps raw fields', async () => {
    mocks.conversationsHistory
      .mockResolvedValueOnce({
        messages: [{ ts: '1.1', user: 'U1', text: 'hi', thread_ts: undefined, reply_count: 0 }],
        response_metadata: { next_cursor: 'cursor-1' },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: '1.2', bot_id: 'B1', text: 'bot message' }],
        response_metadata: { next_cursor: '' },
      });

    const messages = await makeClient().listHistorySince('C1', '1.0');

    expect(mocks.conversationsHistory).toHaveBeenCalledTimes(2);
    expect(mocks.conversationsHistory.mock.calls[0][0]).toMatchObject({ channel: 'C1', oldest: '1.0' });
    expect(messages).toEqual([
      { ts: '1.1', user: 'U1', botId: undefined, text: 'hi', threadTs: undefined, replyCount: 0 },
      { ts: '1.2', user: undefined, botId: 'B1', text: 'bot message', threadTs: undefined, replyCount: undefined },
    ]);
  });

  it('listHistorySince drops raw messages without a ts', async () => {
    mocks.conversationsHistory.mockResolvedValueOnce({
      messages: [{ text: 'no timestamp' }, { ts: '1.1', text: 'ok' }],
      response_metadata: {},
    });

    const messages = await makeClient().listHistorySince('C1');

    expect(messages).toEqual([{ ts: '1.1', user: undefined, botId: undefined, text: 'ok', threadTs: undefined, replyCount: undefined }]);
  });

  it('listReplies pages through conversations.replies', async () => {
    mocks.conversationsReplies.mockResolvedValueOnce({
      messages: [{ ts: '2.1', text: 'reply one' }],
      response_metadata: {},
    });

    const messages = await makeClient().listReplies('C1', '2.0');

    expect(mocks.conversationsReplies).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C1', ts: '2.0' }));
    expect(messages).toEqual([{ ts: '2.1', user: undefined, botId: undefined, text: 'reply one', threadTs: undefined, replyCount: undefined }]);
  });

  it('postMessage returns the posted ts', async () => {
    mocks.chatPostMessage.mockResolvedValueOnce({ ts: '3.1' });

    const result = await makeClient().postMessage('C1', '2.0', 'hello');

    expect(mocks.chatPostMessage).toHaveBeenCalledWith({ channel: 'C1', thread_ts: '2.0', text: 'hello' });
    expect(result).toEqual({ ts: '3.1' });
  });

  it('postMessage throws when Slack does not return a ts', async () => {
    mocks.chatPostMessage.mockResolvedValueOnce({});

    await expect(makeClient().postMessage('C1', '2.0', 'hello')).rejects.toThrow(/did not return a timestamp/);
  });

  it('retries on a rate-limit error carrying retryAfter, then succeeds', async () => {
    const rateLimitError = Object.assign(new Error('rate limited'), { retryAfter: 0 });
    mocks.chatPostMessage
      .mockRejectedValueOnce(rateLimitError)
      .mockResolvedValueOnce({ ts: '4.1' });

    const result = await makeClient().postMessage('C1', '2.0', 'hello');

    expect(mocks.chatPostMessage).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ ts: '4.1' });
  });

  it('does not retry and rethrows a non-rate-limit error', async () => {
    mocks.chatPostMessage.mockRejectedValueOnce(new Error('permanent failure'));

    await expect(makeClient().postMessage('C1', '2.0', 'hello')).rejects.toThrow('permanent failure');
    expect(mocks.chatPostMessage).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

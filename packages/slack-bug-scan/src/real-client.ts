import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { WebClient } from '@slack/web-api';
import type { SlackBugScanChannelSummary, SlackBugScanClient, SlackBugScanMessage } from './contract.js';

function resolveSlackOwnerEnvPath(env: NodeJS.ProcessEnv = process.env): string {
  const legacyOwnerEnvPath = path.join(homedir(), '.invoker', '.slack-owner.env');
  const canonicalEnvPath = path.join(homedir(), '.invoker', '.env');
  return env.INVOKER_SLACK_OWNER_ENV
    ?? (existsSync(legacyOwnerEnvPath) ? legacyOwnerEnvPath : canonicalEnvPath);
}

function loadSlackBotToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.SLACK_BOT_TOKEN) return env.SLACK_BOT_TOKEN;
  const envPath = resolveSlackOwnerEnvPath(env);
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('SLACK_BOT_TOKEN='));
  return line?.slice('SLACK_BOT_TOKEN='.length).trim();
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toMessage(raw: { ts?: string; user?: string; bot_id?: string; text?: string; thread_ts?: string; reply_count?: number }): SlackBugScanMessage | undefined {
  if (!raw.ts) return undefined;
  return {
    ts: raw.ts,
    user: raw.user,
    botId: raw.bot_id,
    text: raw.text ?? '',
    threadTs: raw.thread_ts,
    replyCount: raw.reply_count,
  };
}

export function createRealSlackBugScanClient(env: NodeJS.ProcessEnv = process.env): SlackBugScanClient | undefined {
  const token = loadSlackBotToken(env);
  if (!token) return undefined;
  const client = new WebClient(token);

  async function call<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const result = await fn();
        await sleep(300);
        return result;
      } catch (error) {
        const retryAfter = (error as { retryAfter?: number })?.retryAfter;
        if (typeof retryAfter === 'number') {
          await sleep((retryAfter + 1) * 1000);
          continue;
        }
        throw error;
      }
    }
    throw new Error('Slack API call failed after retries (rate limited).');
  }

  return {
    async listMemberChannels(): Promise<SlackBugScanChannelSummary[]> {
      const channelIds: Array<{ id: string; name?: string }> = [];
      let cursor: string | undefined;
      do {
        const page = await call(() => client.users.conversations({
          types: 'public_channel,private_channel',
          exclude_archived: true,
          limit: 200,
          cursor,
        }));
        for (const channel of page.channels ?? []) {
          if (!channel.id) continue;
          channelIds.push({ id: channel.id, name: channel.name });
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);

      const channels: SlackBugScanChannelSummary[] = [];
      for (const { id, name } of channelIds) {
        const info = await call(() => client.conversations.info({ channel: id }));
        channels.push({
          id,
          name,
          topic: info.channel?.topic?.value,
          purpose: info.channel?.purpose?.value,
        });
      }
      return channels;
    },

    async listHistorySince(channelId: string, oldestTs?: string): Promise<SlackBugScanMessage[]> {
      const messages: SlackBugScanMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(() => client.conversations.history({
          channel: channelId,
          oldest: oldestTs,
          limit: 200,
          cursor,
        }));
        for (const raw of page.messages ?? []) {
          const message = toMessage(raw);
          if (message) messages.push(message);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return messages;
    },

    async listReplies(channelId: string, threadTs: string): Promise<SlackBugScanMessage[]> {
      const messages: SlackBugScanMessage[] = [];
      let cursor: string | undefined;
      do {
        const page = await call(() => client.conversations.replies({
          channel: channelId,
          ts: threadTs,
          limit: 200,
          cursor,
        }));
        for (const raw of page.messages ?? []) {
          const message = toMessage(raw);
          if (message) messages.push(message);
        }
        cursor = page.response_metadata?.next_cursor || undefined;
      } while (cursor);
      return messages;
    },

    async postMessage(channelId: string, threadTs: string, text: string): Promise<{ ts: string }> {
      const result = await call(() => client.chat.postMessage({ channel: channelId, thread_ts: threadTs, text }));
      if (!result.ts) throw new Error('Slack did not return a timestamp for the posted message.');
      return { ts: result.ts };
    },
  };
}

/**
 * Live Slack-channel e2e for workflow-channel @mention replies.
 *
 * Credential-gated. Skip (do not pass) without INVOKER_E2E_SLACK_LIVE=1 and
 * SLACK_BOT_TOKEN. Intended to run on DO1 against the live slack-manager smoke
 * inject (INVOKER_SLACK_ALLOW_LOCAL_SMOKE=1) while polling the real channel.
 *
 * Target default: C0BTTHFM02U (workflow-1787780633273-11).
 *
 * Literal property: after inject, conversations.replies contains a bot reply
 * (Processing your request... or any bot message) within 15s.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { DEFAULT_SMOKE_INJECT_PORT } from '../local-smoke-inject.js';

const LIVE = process.env.INVOKER_E2E_SLACK_LIVE === '1';
const CHANNEL_ID = process.env.INVOKER_E2E_SLACK_CHANNEL_ID ?? 'C0BTTHFM02U';
const SMOKE_PORT = Number.parseInt(
  process.env.INVOKER_SLACK_SMOKE_PORT ?? String(DEFAULT_SMOKE_INJECT_PORT),
  10,
);
const PROBE_TEXT = 'Can you help me figure out why that failed and execute a fix with claude?';
const REPLY_TIMEOUT_MS = 15_000;
const POLL_MS = 500;

function loadBotToken(): string | undefined {
  if (process.env.SLACK_BOT_TOKEN) return process.env.SLACK_BOT_TOKEN;
  const legacy = path.join(homedir(), '.invoker', '.slack-owner.env');
  const canonical = path.join(homedir(), '.invoker', '.env');
  const envPath = process.env.INVOKER_SLACK_OWNER_ENV
    ?? (existsSync(legacy) ? legacy : canonical);
  if (!existsSync(envPath)) return undefined;
  const line = readFileSync(envPath, 'utf8').split('\n').find((l) => l.startsWith('SLACK_BOT_TOKEN='));
  return line?.slice('SLACK_BOT_TOKEN='.length).trim();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function slackApi<T>(token: string, method: string, body: Record<string, unknown>): Promise<T & { ok: boolean; error?: string }> {
  // Slack Web API expects form-urlencoded for most methods; JSON can yield invalid_arguments.
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(body)) {
    if (value === undefined || value === null) continue;
    form.set(key, typeof value === 'string' ? value : String(value));
  }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: form.toString(),
  });
  const json = await res.json() as T & { ok: boolean; error?: string };
  if (!json.ok) throw new Error(`Slack ${method} failed: ${json.error ?? res.status}`);
  return json;
}

async function injectMention(body: {
  channelId: string;
  threadTs: string;
  text: string;
  userId: string;
}): Promise<void> {
  const payload = JSON.stringify(body);
  await new Promise<void>((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: SMOKE_PORT,
      path: '/smoke/mention',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
      },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed: { ok?: boolean; error?: string } = {};
        try {
          parsed = JSON.parse(raw) as { ok?: boolean; error?: string };
        } catch {
          reject(new Error(`smoke inject non-JSON response (${res.statusCode}): ${raw}`));
          return;
        }
        if (res.statusCode !== 200 || !parsed.ok) {
          reject(new Error(`smoke inject failed (${res.statusCode}): ${parsed.error ?? raw}`));
          return;
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

describe.skipIf(!LIVE)('live Slack workflow-channel mention reply', () => {
  it('posts a bot reply into the mapped workflow channel within 15s', async () => {
    const token = loadBotToken();
    if (!token) {
      throw new Error('INVOKER_E2E_SLACK_LIVE=1 requires SLACK_BOT_TOKEN (or ~/.invoker/.slack-owner.env)');
    }

    const auth = await slackApi<{ user_id?: string }>(token, 'auth.test', {});
    const botUserId = auth.user_id;
    const marker = `invoker-live-e2e-${Date.now()}`;
    const posted = await slackApi<{ ts?: string }>(token, 'chat.postMessage', {
      channel: CHANNEL_ID,
      text: marker,
    });
    const threadTs = posted.ts;
    if (!threadTs) throw new Error('chat.postMessage returned no ts');

    const toDelete: string[] = [threadTs];
    try {
      // Fire-and-forget: inject may wait on the planner; the ack must land first.
      const injectPromise = injectMention({
        channelId: CHANNEL_ID,
        threadTs,
        text: PROBE_TEXT,
        userId: process.env.INVOKER_E2E_SLACK_USER_ID ?? 'U_LIVE_E2E',
      }).catch((err) => {
        console.warn(`[live-e2e] inject settled with error (ok if ack already posted): ${err}`);
      });

      const deadline = Date.now() + REPLY_TIMEOUT_MS;
      let botReply: { ts?: string; text?: string; bot_id?: string; user?: string } | undefined;
      while (Date.now() < deadline) {
        const replies = await slackApi<{ messages?: Array<{ ts?: string; text?: string; bot_id?: string; user?: string }> }>(
          token,
          'conversations.replies',
          {
            channel: CHANNEL_ID,
            ts: threadTs,
            limit: 50,
          },
        );
        botReply = (replies.messages ?? []).find((m) => {
          if (m.ts === threadTs) return false;
          if (m.bot_id) return true;
          if (m.user && botUserId && m.user === botUserId) return true;
          return false;
        });
        if (botReply) break;
        await sleep(POLL_MS);
      }

      if (botReply?.ts) toDelete.push(botReply.ts);

      expect(
        botReply,
        `Expected a bot reply in ${CHANNEL_ID} thread ${threadTs} within ${REPLY_TIMEOUT_MS}ms (marker=${marker})`,
      ).toBeDefined();
      expect(botReply?.text ?? '').toMatch(/Processing your request|Error:|Still thinking|I answer questions|workflow/i);

      await Promise.race([injectPromise, sleep(2_000)]);
    } finally {
      for (const ts of toDelete.reverse()) {
        try {
          await slackApi(token, 'chat.delete', { channel: CHANNEL_ID, ts });
        } catch {
          // best-effort cleanup
        }
      }
    }
  }, 60_000);
});

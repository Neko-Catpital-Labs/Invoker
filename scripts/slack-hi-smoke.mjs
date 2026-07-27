#!/usr/bin/env node
/**
 * Live Slack "hi" smoke driver.
 *
 * Drives the opt-in, localhost-only hi-smoke hook exposed by a running
 * slack-manager (see packages/slack-manager/src/hi-smoke-server.ts): it POSTs
 * to 127.0.0.1:<port>/hi, which posts a real parent message to the configured
 * lobby and feeds `hi` through the ordinary planning-mention route so the
 * normal Slack response path posts the LLM reply in that same thread. The
 * driver then polls the thread until a non-error LLM greeting arrives.
 *
 * Usage:
 *   INVOKER_SLACK_HI_SMOKE=1 node scripts/slack-hi-smoke.mjs [--text "hi"] [--timeout 180]
 *
 * Env:
 *   INVOKER_SLACK_HI_SMOKE           required opt-in gate (mirrors the server gate)
 *   INVOKER_SLACK_HI_SMOKE_PORT      loopback port (default 8477)
 *   INVOKER_SLACK_OWNER_ENV          env file with SLACK_BOT_TOKEN/SLACK_CHANNEL_ID
 *
 * Exit 0 = a non-error LLM greeting was posted in the thread; nonzero otherwise.
 */

import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8477;
const ERROR_MARKERS = ['No API key', 'omp exited', 'Error:', 'Traceback (most recent call last)', '    at '];
const TRANSIENT_TEXTS = ['processing your request', 'still thinking', 'thinking…', 'on it'];

function parseArgs(argv) {
  const args = { text: 'hi', timeout: 180 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--text') args.text = argv[++i];
    else if (argv[i] === '--timeout') args.timeout = Number(argv[++i]);
  }
  return args;
}

function loadEnvFile() {
  const candidates = [
    process.env.INVOKER_SLACK_OWNER_ENV,
    path.join(homedir(), '.invoker', '.slack-owner.env'),
    path.join(homedir(), '.invoker', '.env'),
  ].filter(Boolean);
  const out = {};
  for (const file of candidates) {
    if (!file || !existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (m && out[m[1]] === undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
    break;
  }
  return out;
}

async function slack(method, token, params) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
  const body = await res.json();
  if (!body.ok) throw new Error(`slack ${method} failed: ${body.error}`);
  return body;
}

function classifyReply(messages, parentTs) {
  for (const msg of messages) {
    if (msg.ts === parentTs) continue;
    const text = (msg.text ?? '').trim();
    if (!text) continue;
    const lower = text.toLowerCase();
    if (TRANSIENT_TEXTS.some((t) => lower.includes(t))) continue;
    const badMarker = ERROR_MARKERS.find((mk) => text.includes(mk));
    return { ts: msg.ts, text, error: badMarker ?? null };
  }
  return null;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!process.env.INVOKER_SLACK_HI_SMOKE) {
    console.error('Refusing to run: set INVOKER_SLACK_HI_SMOKE=1 to opt in.');
    process.exit(2);
  }
  const port = process.env.INVOKER_SLACK_HI_SMOKE_PORT ? Number(process.env.INVOKER_SLACK_HI_SMOKE_PORT) : DEFAULT_PORT;
  const env = loadEnvFile();
  const token = env.SLACK_BOT_TOKEN;
  if (!token) {
    console.error('Missing SLACK_BOT_TOKEN in the Slack owner env file; cannot poll the thread.');
    process.exit(2);
  }

  console.error(`[smoke] injecting via http://${HOST}:${port}/hi text="${args.text}"`);
  let injection;
  try {
    const res = await fetch(`http://${HOST}:${port}/hi`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: args.text }),
    });
    injection = await res.json();
    if (!res.ok || !injection.ok) throw new Error(injection.error ?? `HTTP ${res.status}`);
  } catch (err) {
    console.error(`[smoke] injection request failed: ${err.message}`);
    console.error('[smoke] is slack-manager running with INVOKER_SLACK_HI_SMOKE set?');
    process.exit(1);
  }

  const { channel, parentTs } = injection;
  const permalink = await slack('chat.getPermalink', token, { channel, message_ts: parentTs })
    .then((b) => b.permalink)
    .catch(() => null);
  console.error(`[smoke] parent posted channel=${channel} ts=${parentTs}${permalink ? ` url=${permalink}` : ''}`);

  const deadline = Date.now() + args.timeout * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const replies = await slack('conversations.replies', token, { channel, ts: parentTs, limit: 50 });
    const reply = classifyReply(replies.messages ?? [], parentTs);
    if (reply) {
      last = reply;
      if (reply.error) {
        console.error(`[smoke] FAIL — worker-owned error reply: ${JSON.stringify(reply.text.slice(0, 300))}`);
        console.log(JSON.stringify({ ok: false, reason: 'error-reply', marker: reply.error, channel, parentTs, permalink, reply: reply.text }, null, 2));
        process.exit(1);
      }
      console.error('[smoke] PASS — non-error LLM reply posted in thread');
      console.log(JSON.stringify({ ok: true, channel, parentTs, permalink, replyTs: reply.ts, reply: reply.text }, null, 2));
      process.exit(0);
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  console.error(`[smoke] TIMEOUT after ${args.timeout}s with no LLM reply`);
  console.log(JSON.stringify({ ok: false, reason: 'timeout', channel, parentTs, permalink, last }, null, 2));
  process.exit(1);
}

main().catch((err) => {
  console.error(`[smoke] fatal: ${err.stack ?? err.message}`);
  process.exit(1);
});

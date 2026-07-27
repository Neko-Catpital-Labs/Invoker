#!/usr/bin/env node
/**
 * Live Slack "hi" smoke driver.
 *
 * Triggers the opt-in, localhost-only smoke hook exposed by a running
 * @invoker/slack-manager (see packages/slack-manager/src/slack-hi-smoke.ts),
 * which posts a parent message to the lobby and feeds `hi` through the ordinary
 * planning-mention → response-posting path. This script then polls the Slack
 * thread until the LLM reply lands (or a timeout), and PASSES only when the
 * reply is a non-error greeting/acknowledgement.
 *
 * Slack does not reliably deliver an app's own app_mention back to itself, so a
 * localhost-injected event — not a bot self-mention — is the proof trigger.
 *
 * Usage: node scripts/slack-hi-smoke.mjs
 * Env:
 *   INVOKER_SLACK_HI_SMOKE_PORT  smoke hook port (default 8765)
 *   SLACK_HI_SMOKE_TIMEOUT_MS    poll timeout (default 240000)
 *   INVOKER_SLACK_OWNER_ENV      env file with SLACK_BOT_TOKEN (default ~/.invoker/.slack-owner.env|.env)
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const ACK_TEXTS = new Set(['Processing your request...']);
const HEARTBEAT_MARKERS = [':hourglass_flowing_sand:', 'Still thinking...'];
const ERROR_MARKERS = [/No API key/i, /omp exited/i, /codex exited/i];
const STACK_TRACE_RE = /\n\s*at\s+.+:\d+:\d+/;

function loadEnvFile(file) {
  if (!file || !existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

async function slack(method, token, params) {
  // Slack Web API read methods (conversations.replies, chat.getPermalink)
  // reject JSON bodies with invalid_arguments; form-encoding works for all.
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) form.set(k, String(v));
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
    },
    body: form.toString(),
  });
  return res.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function classify(text) {
  const t = (text ?? '').trim();
  if (!t) return { pass: false, reason: 'empty reply' };
  for (const re of ERROR_MARKERS) if (re.test(t)) return { pass: false, reason: `error marker: ${re}` };
  if (STACK_TRACE_RE.test(t)) return { pass: false, reason: 'stack trace in reply' };
  if (/^Error:/i.test(t)) return { pass: false, reason: 'reply is an error message' };
  return { pass: true, reason: 'non-error LLM reply' };
}

function isReplyCandidate(msg, parentTs) {
  if (!msg || msg.ts === parentTs) return false;
  const text = msg.text ?? '';
  if (ACK_TEXTS.has(text.trim())) return false;
  if (HEARTBEAT_MARKERS.some((m) => text.includes(m))) return false;
  return text.trim().length > 0;
}

async function main() {
  const ownerEnv =
    process.env.INVOKER_SLACK_OWNER_ENV ??
    (existsSync(path.join(homedir(), '.invoker', '.slack-owner.env'))
      ? path.join(homedir(), '.invoker', '.slack-owner.env')
      : path.join(homedir(), '.invoker', '.env'));
  loadEnvFile(ownerEnv);

  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) throw new Error(`SLACK_BOT_TOKEN not found (looked in ${ownerEnv})`);

  const port = process.env.INVOKER_SLACK_HI_SMOKE_PORT ?? '8765';
  const timeoutMs = Number(process.env.SLACK_HI_SMOKE_TIMEOUT_MS ?? 240_000);

  process.stdout.write(`[hi-smoke] triggering localhost hook http://127.0.0.1:${port}/smoke/hi\n`);
  const triggerRes = await fetch(`http://127.0.0.1:${port}/smoke/hi`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hi' }),
  }).catch((err) => {
    throw new Error(`could not reach smoke hook on 127.0.0.1:${port} (is slack-manager running with INVOKER_SLACK_HI_SMOKE=1?): ${err.message}`);
  });
  const trigger = await triggerRes.json();
  if (!trigger.ok) throw new Error(`smoke hook returned failure: ${JSON.stringify(trigger)}`);
  const { channel, threadTs } = trigger;
  process.stdout.write(`[hi-smoke] injected parent thread channel=${channel} thread_ts=${threadTs}\n`);

  const permalinkRes = await slack('chat.getPermalink', token, { channel, message_ts: threadTs });
  const permalink = permalinkRes.ok ? permalinkRes.permalink : `(permalink unavailable: ${permalinkRes.error})`;

  const deadline = Date.now() + timeoutMs;
  let lastReply;
  while (Date.now() < deadline) {
    const replies = await slack('conversations.replies', token, { channel, ts: threadTs, limit: 50 });
    if (!replies.ok) {
      process.stdout.write(`[hi-smoke] conversations.replies error: ${replies.error}\n`);
      await sleep(5_000);
      continue;
    }
    const candidate = [...(replies.messages ?? [])].reverse().find((m) => isReplyCandidate(m, threadTs));
    if (candidate) {
      lastReply = candidate;
      break;
    }
    await sleep(5_000);
  }

  const result = {
    channel,
    threadTs,
    permalink,
    reply: lastReply ? lastReply.text : null,
    replyTs: lastReply ? lastReply.ts : null,
  };

  if (!lastReply) {
    result.pass = false;
    result.reason = `timed out after ${timeoutMs}ms with no LLM reply`;
  } else {
    Object.assign(result, classify(lastReply.text));
  }

  process.stdout.write(`\n[hi-smoke] RESULT ${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.pass ? 0 : 1);
}

main().catch((err) => {
  process.stderr.write(`[hi-smoke] fatal: ${err.message}\n`);
  process.exit(2);
});

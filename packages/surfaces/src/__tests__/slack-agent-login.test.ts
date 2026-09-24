import { describe, it, expect } from 'vitest';
import {
  AGENT_LOGIN_METADATA_EVENT_TYPE,
  AGENT_LOGIN_NOT_ADMIN_MESSAGE,
  AgentLoginThreadController,
  buildAgentLoginAlertMetadata,
  normalizeAgentLoginResult,
  parseAgentLoginAlertKey,
  readAgentLoginMetadata,
  redactTokenLike,
  type AgentLoginTarget,
} from '../slack/slack-agent-login.js';

const ADMIN = 'U_ADMIN';
const STRANGER = 'U_STRANGER';
const CHANNEL = 'C_LOBBY';
const THREAD = '1757000000.000100';
const SESSION = 'agent-login-7f3c';
const LOGIN_URL = 'https://claude.ai/login/device';
const LEAKED_TOKEN = 'sk-ant-oat01-Hx8Qm2ZvT4pL9rW6yB3nK1sD5gJ7cF0aRuXeVbNmQpZiOlYtHg';

const TARGET: AgentLoginTarget = { host: 'DO1', agent: 'claude' };

interface Harness {
  controller: AgentLoginThreadController;
  execCalls: string[][];
  posts: string[];
}

function makeHarness(options: {
  target?: AgentLoginTarget | null;
  admins?: string[];
  results?: unknown[];
  execError?: Error;
} = {}): Harness {
  const execCalls: string[][] = [];
  const posts: string[] = [];
  const admins = new Set(options.admins ?? [ADMIN]);
  const results = [...(options.results ?? [])];

  const controller = new AgentLoginThreadController({
    isAdmin: (userId) => !!userId && admins.has(userId),
    resolveTarget: async () => (options.target === undefined ? TARGET : options.target),
    runHeadlessCommand: async (args) => {
      execCalls.push(args);
      if (options.execError) throw options.execError;
      if (!results.length) throw new Error(`unexpected exec call: ${args.join(' ')}`);
      return results.shift();
    },
    post: async (text) => {
      posts.push(text);
    },
  });

  return { controller, execCalls, posts };
}

function startResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION,
    provider: 'claude',
    status: 'awaiting_code',
    url: LOGIN_URL,
    userCode: 'WDJB-MJHT',
    message: 'Open the link, then send the code back.',
    ...overrides,
  };
}

describe('agent-login alert metadata', () => {
  it('parses the worker alert key into a host and agent', () => {
    expect(parseAgentLoginAlertKey('agent-login:DO1:claude')).toEqual({ host: 'DO1', agent: 'claude' });
    expect(parseAgentLoginAlertKey('agent-login:pool-2:codex')).toEqual({ host: 'pool-2', agent: 'codex' });
  });

  it('ignores keys from other alerts and unknown agents', () => {
    expect(parseAgentLoginAlertKey('spend-circuit:DO1:claude')).toBeNull();
    expect(parseAgentLoginAlertKey('agent-login:DO1:gemini')).toBeNull();
    expect(parseAgentLoginAlertKey('agent-login:claude')).toBeNull();
  });

  it('round-trips the host and agent through typed Slack message metadata', () => {
    const metadata = buildAgentLoginAlertMetadata('agent-login:DO1:claude');
    expect(metadata).toEqual({
      event_type: AGENT_LOGIN_METADATA_EVENT_TYPE,
      event_payload: { host: 'DO1', agent: 'claude' },
    });
    expect(readAgentLoginMetadata(metadata)).toEqual(TARGET);
  });

  it('attaches no metadata to non-agent-login alerts', () => {
    expect(buildAgentLoginAlertMetadata('disk-headroom:DO1')).toBeUndefined();
  });

  it('rejects metadata from other event types or malformed payloads', () => {
    expect(readAgentLoginMetadata(undefined)).toBeNull();
    expect(readAgentLoginMetadata({ event_type: 'something_else', event_payload: { host: 'DO1', agent: 'claude' } })).toBeNull();
    expect(readAgentLoginMetadata({ event_type: AGENT_LOGIN_METADATA_EVENT_TYPE, event_payload: { host: 'DO1' } })).toBeNull();
    expect(readAgentLoginMetadata({ event_type: AGENT_LOGIN_METADATA_EVENT_TYPE, event_payload: { host: '', agent: 'claude' } })).toBeNull();
  });
});

describe('agent-login reply walkthrough', () => {
  it('starts the login for an admin reauth and posts the link and code in the thread', async () => {
    const h = makeHarness({ results: [startResult()] });

    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'reauth',
    });

    expect(handled).toBe(true);
    expect(h.execCalls).toEqual([['agent-login', 'start', 'claude', '--output', 'json']]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toContain(LOGIN_URL);
    expect(h.posts[0]).toContain('WDJB-MJHT');
    expect(h.posts[0]).toContain('DO1');
  });

  it('refuses a non-admin reply and never runs a command', async () => {
    const h = makeHarness({ results: [startResult()] });

    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: STRANGER,
      text: 'reauth',
    });

    expect(handled).toBe(true);
    expect(h.execCalls).toEqual([]);
    expect(h.posts).toEqual([AGENT_LOGIN_NOT_ADMIN_MESSAGE]);
  });

  it('refuses a reply with no user id', async () => {
    const h = makeHarness({ results: [startResult()] });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, text: 'reauth' });

    expect(h.execCalls).toEqual([]);
    expect(h.posts).toEqual([AGENT_LOGIN_NOT_ADMIN_MESSAGE]);
  });

  it('passes the next admin reply on as the login code and posts the final result', async () => {
    const h = makeHarness({
      results: [
        startResult(),
        {
          sessionId: SESSION,
          provider: 'claude',
          status: 'installed',
          message: 'The new claude login passed its test call and is installed.',
        },
      ],
    });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });
    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'WDJB-MJHT',
    });

    expect(handled).toBe(true);
    expect(h.execCalls[1]).toEqual(['agent-login', 'code', SESSION, 'WDJB-MJHT', '--output', 'json']);
    expect(h.posts[1]).toContain('installed');
  });

  it('accepts a JSON stdout line from the headless command', async () => {
    const h = makeHarness({ results: [JSON.stringify(startResult())] });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });

    expect(h.posts[0]).toContain(LOGIN_URL);
  });

  it('leaves replies in threads without agent-login metadata to the other handlers', async () => {
    const h = makeHarness({ target: null, results: [startResult()] });

    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'reauth',
    });

    expect(handled).toBe(false);
    expect(h.execCalls).toEqual([]);
    expect(h.posts).toEqual([]);
  });

  it('explains and hints reauth when no session in this thread is waiting for a code', async () => {
    const h = makeHarness({ results: [] });

    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'WDJB-MJHT',
    });

    expect(handled).toBe(true);
    expect(h.execCalls).toEqual([]);
    expect(h.posts[0]).toContain('reauth');
    expect(h.posts[0]).toContain('DO1');
  });

  it('does not send prose chatter on as a login code', async () => {
    const h = makeHarness({ results: [startResult()] });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });
    await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'what is taking so long',
    });

    expect(h.execCalls).toHaveLength(1);
    expect(h.posts[1]).toContain('reauth');
  });

  it('stops expecting a code after a failed start and reports the failure', async () => {
    const h = makeHarness({
      results: [
        startResult({ status: 'failed', url: undefined, userCode: undefined, message: 'The claude login failed: pty spawn failed. The live login was left untouched.' }),
      ],
    });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });
    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'WDJB-MJHT' });

    expect(h.execCalls).toHaveLength(1);
    expect(h.posts[0]).toContain('left untouched');
    expect(h.posts[1]).toContain('reauth');
  });

  it('reports an expired session from the code command and re-offers reauth', async () => {
    const h = makeHarness({
      results: [
        startResult(),
        {
          sessionId: SESSION,
          provider: 'claude',
          status: 'failed',
          message: 'The claude login failed: session expired. The live login was left untouched.',
        },
      ],
    });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });
    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'WDJB-MJHT' });

    expect(h.posts[1]).toContain('session expired');
    expect(h.posts[1]).toContain('reauth');
  });

  it('explains a command that could not run instead of staying silent', async () => {
    const h = makeHarness({ execError: new Error('owner is not reachable') });

    const handled = await h.controller.handleReply({
      channel: CHANNEL,
      threadTs: THREAD,
      userId: ADMIN,
      text: 'reauth',
    });

    expect(handled).toBe(true);
    expect(h.posts[0]).toContain('owner is not reachable');
    expect(h.posts[0]).toContain('left untouched');
  });

  it('explains an unreadable result instead of posting it', async () => {
    const h = makeHarness({ results: [{ nonsense: true, token: LEAKED_TOKEN }] });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });

    expect(h.posts[0]).toContain('could not read');
    expect(h.posts.join('\n')).not.toContain(LEAKED_TOKEN);
  });
});

describe('agent-login never posts a token', () => {
  it('redacts token-shaped strings', () => {
    expect(redactTokenLike(`token=${LEAKED_TOKEN}`)).not.toContain(LEAKED_TOKEN);
    expect(redactTokenLike('deadbeef'.repeat(6))).not.toContain('deadbeef'.repeat(6));
    expect(redactTokenLike('eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVP')).toContain('[redacted]');
    expect(redactTokenLike(`open ${LOGIN_URL}`)).toBe(`open ${LOGIN_URL}`);
  });

  it('drops token fields the owner result was not supposed to carry', () => {
    const view = normalizeAgentLoginResult({ ...startResult(), token: LEAKED_TOKEN, authFile: '{"access_token":"x"}' });
    expect(JSON.stringify(view)).not.toContain(LEAKED_TOKEN);
    expect(JSON.stringify(view)).not.toContain('access_token');
  });

  it('keeps a token out of every posted line across the whole walkthrough', async () => {
    const h = makeHarness({
      results: [
        { ...startResult(), token: LEAKED_TOKEN },
        {
          sessionId: SESSION,
          provider: 'claude',
          status: 'installed',
          message: `Installed. CLAUDE_CODE_OAUTH_TOKEN=${LEAKED_TOKEN}`,
          token: LEAKED_TOKEN,
        },
      ],
    });

    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'reauth' });
    await h.controller.handleReply({ channel: CHANNEL, threadTs: THREAD, userId: ADMIN, text: 'WDJB-MJHT' });

    expect(h.posts).toHaveLength(2);
    for (const post of h.posts) {
      expect(post).not.toContain(LEAKED_TOKEN);
      expect(post).not.toMatch(/\bsk-[A-Za-z0-9_-]{12,}/);
    }
    expect(h.posts[1]).toContain('[redacted]');
  });
});

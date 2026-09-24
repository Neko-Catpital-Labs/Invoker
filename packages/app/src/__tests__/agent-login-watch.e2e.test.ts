import { expect, it, vi } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Channels, LocalBus } from '@invoker/transport';
import {
  createWorkerRegistry,
  registerBuiltinWorkers,
  type WorkerRuntimeDependencies,
} from '@invoker/execution-engine';
import type { SlackSurface as SlackSurfaceType, SurfaceEvent } from '@invoker/surfaces';

import { getAgentLoginStatus } from '../agent-login-session.js';
import { runHeadless, type HeadlessDeps } from '../headless.js';

interface MockEventHandler {
  name: string;
  handler: (args: { event: Record<string, unknown>; say: (msg: unknown) => Promise<void> }) => Promise<void> | void;
}

interface PostedMessage {
  channel: string;
  text: string;
  thread_ts?: string;
  metadata?: { event_type: string; event_payload: Record<string, string> };
  ts: string;
}

const postedMessages: PostedMessage[] = [];
let tsSeq = 0;

class MockApp {
  _eventHandlers: MockEventHandler[] = [];
  command = vi.fn();
  action = vi.fn();
  event = vi.fn(function (this: MockApp, name: string, handler: MockEventHandler['handler']) {
    this._eventHandlers.push({ name, handler });
  });
  start = vi.fn().mockResolvedValue(undefined);
  stop = vi.fn().mockResolvedValue(undefined);
  client = {
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'U_BOT' }) },
    chat: {
      postMessage: vi.fn((args: Omit<PostedMessage, 'ts'>) => {
        tsSeq += 1;
        const ts = `${1_700_000_000 + tsSeq}.000000`;
        postedMessages.push({ ...args, ts });
        return Promise.resolve({ ts });
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    conversations: {
      replies: vi.fn().mockResolvedValue({ messages: [{}] }),
    },
    reactions: {
      add: vi.fn().mockResolvedValue({}),
      remove: vi.fn().mockResolvedValue({}),
    },
    files: {
      uploadV2: vi.fn().mockResolvedValue({ files: [{ files: [{ id: 'F_TEST' }] }] }),
    },
  };
}

const surfacesPackageDir = join(dirname(fileURLToPath(import.meta.url)), '../../../surfaces');
const boltModulePath = createRequire(import.meta.url).resolve('@slack/bolt', { paths: [surfacesPackageDir] });
vi.doMock(boltModulePath, () => ({ App: MockApp }));

const OWNER_HOST = 'DO1';
const LOBBY_CHANNEL = 'C_LOBBY';
const ADMIN = 'U_ADMIN';
const STRANGER = 'U_STRANGER';
const NOT_ADMIN_MESSAGE = 'Permission denied. Only Invoker Slack admins can start an agent login or send a login code.';
const OLD_CODEX_AUTH = '{"access_token":"old-revoked-codex-token"}';
const OLD_CLAUDE_TOKEN = 'old-revoked-claude-token';
const FRESH_CLAUDE_TOKEN = 'sk-ant-oat01-e2efaketoken0001';
const CLAUDE_CODE = '778899';

const CLAUDE_SCRIPT = `#!/bin/bash
if [ "$1" = "setup-token" ]; then
  echo "Open this link to sign in: https://claude.ai/oauth/authorize?fake=e2e"
  read -r CODE
  echo "Verifying code $CODE..."
  echo "Your Claude Code OAuth token: ${FRESH_CLAUDE_TOKEN}"
  exit 0
fi
if [ "$1" = "-p" ]; then
  TOKEN="$CLAUDE_CODE_OAUTH_TOKEN"
  if [ -z "$TOKEN" ] && [ -f "$HOME/.config/invoker/secrets.env" ]; then
    TOKEN=$(grep '^CLAUDE_CODE_OAUTH_TOKEN=' "$HOME/.config/invoker/secrets.env" | tail -n1 | cut -d= -f2-)
  fi
  case "$TOKEN" in
    sk-ant-oat*)
      echo ok
      exit 0
      ;;
  esac
  echo "Failed to authenticate: OAuth session expired and could not be refreshed" >&2
  exit 1
fi
echo "unsupported claude invocation: $*" >&2
exit 1
`;

const CODEX_SCRIPT = `#!/bin/bash
if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then
  AUTH_PATH="$CODEX_HOME/auth.json"
  mkdir -p "$(dirname "$AUTH_PATH")"
  echo "Open this link to authenticate: https://github.com/login/device?fake=e2e"
  echo "Enter code: WDJB-MJHT"
  printf '{"access_token":"valid-token-codex-e2e"}' > "$AUTH_PATH"
  exit 0
fi
if [ "$1" = "login" ] && [ "$2" = "status" ]; then
  AUTH_PATH="\${CODEX_HOME:-$HOME/.codex}/auth.json"
  if [ -f "$AUTH_PATH" ] && grep -q 'valid-token' "$AUTH_PATH"; then exit 0; fi
  exit 1
fi
if [ "$1" = "exec" ]; then
  AUTH_PATH="\${CODEX_HOME:-$HOME/.codex}/auth.json"
  if [ -f "$AUTH_PATH" ] && grep -q 'valid-token' "$AUTH_PATH"; then
    echo ok
    exit 0
  fi
  echo "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again." >&2
  exit 1
fi
echo "unsupported codex invocation: $*" >&2
exit 1
`;

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(() => logger),
  };
  return logger;
}

function makeWorkerStore() {
  const rows = new Map<string, unknown>();
  return {
    getWorkerAction(workerKind: string, externalKey: string): unknown {
      return rows.get(`${workerKind}:${externalKey}`);
    },
    upsertWorkerAction(action: { workerKind: string; externalKey: string }): unknown {
      const record = { ...action };
      rows.set(`${action.workerKind}:${action.externalKey}`, record);
      return record;
    },
  };
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function alertPosts(): PostedMessage[] {
  return postedMessages.filter((message) => !message.thread_ts && message.metadata);
}

function threadPosts(threadTs: string): PostedMessage[] {
  return postedMessages.filter((message) => message.thread_ts === threadTs);
}

async function deliverThreadReply(
  app: { _eventHandlers: MockEventHandler[] },
  reply: { channel: string; threadTs: string; user?: string; text: string },
): Promise<void> {
  const messageHandler = app._eventHandlers.find((entry) => entry.name === 'message');
  if (!messageHandler) throw new Error('message event handler was not registered');
  await messageHandler.handler({
    event: {
      type: 'message',
      channel: reply.channel,
      thread_ts: reply.threadTs,
      user: reply.user,
      text: reply.text,
    },
    say: vi.fn(),
  });
}

it(
  'drives the real worker, real login engine, and real SlackSurface through a full Codex and Claude relogin',
  async () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), 'agent-login-watch-e2e-'));
    const fakeHome = join(tmpRoot, 'home');
    const fakeBin = join(tmpRoot, 'bin');
    mkdirSync(fakeHome, { recursive: true });
    mkdirSync(fakeBin, { recursive: true });
    writeFileSync(join(fakeBin, 'claude'), CLAUDE_SCRIPT, { mode: 0o755 });
    writeFileSync(join(fakeBin, 'codex'), CODEX_SCRIPT, { mode: 0o755 });

    const codexDir = join(fakeHome, '.codex');
    const codexAuthPath = join(codexDir, 'auth.json');
    mkdirSync(codexDir, { recursive: true });
    writeFileSync(codexAuthPath, OLD_CODEX_AUTH);

    const secretsDir = join(fakeHome, '.config', 'invoker');
    const secretsPath = join(secretsDir, 'secrets.env');
    mkdirSync(secretsDir, { recursive: true });
    writeFileSync(secretsPath, `CLAUDE_CODE_OAUTH_TOKEN=${OLD_CLAUDE_TOKEN}\n`);

    const originalHome = process.env.HOME;
    const originalPath = process.env.PATH;
    process.env.HOME = fakeHome;
    process.env.PATH = `${fakeBin}:${originalPath}`;

    try {
      const { SlackSurface } = (await import('@invoker/surfaces')) as { SlackSurface: typeof SlackSurfaceType };
      const bus = new LocalBus();
      let codexSessionId: string | undefined;
      const runHeadlessCommand = async (args: string[]): Promise<unknown> => {
        const result = await runHeadless(args, {} as HeadlessDeps);
        if (args[0] === 'agent-login' && args[1] === 'start' && args[2] === 'codex') {
          codexSessionId = (result as { sessionId: string }).sessionId;
        }
        return result;
      };

      const surface = new SlackSurface({
        botToken: 'xoxb-test',
        appToken: 'xapp-test',
        signingSecret: 'test-secret',
        channelId: LOBBY_CHANNEL,
        lobbyChannelId: LOBBY_CHANNEL,
        adminUserIds: [ADMIN],
        runHeadlessCommand,
      });
      await surface.start(async () => {});
      const app = surface.getApp() as unknown as { _eventHandlers: MockEventHandler[] };

      const pendingAlerts: Promise<void>[] = [];
      bus.subscribe(Channels.SURFACE_EVENT, (message) => {
        pendingAlerts.push(surface.handleEvent(message as SurfaceEvent));
      });

      const registry = registerBuiltinWorkers(createWorkerRegistry());
      const definition = registry.get('agent-login-watch');
      if (!definition) throw new Error('agent-login-watch worker is not registered');
      const worker = definition.factory({
        store: makeWorkerStore(),
        logger: makeLogger(),
        messageBus: bus,
        agentLoginWatch: {
          enabled: true,
          tickOnStart: false,
          ownerHostName: OWNER_HOST,
          agents: ['claude', 'codex'],
          probeTimeoutMs: 15_000,
        },
      } as unknown as WorkerRuntimeDependencies);

      await worker.tick('manual');
      await Promise.all(pendingAlerts.splice(0));

      expect(alertPosts()).toHaveLength(2);
      const claudeAlert = alertPosts().find((post) => post.metadata?.event_payload.agent === 'claude');
      const codexAlert = alertPosts().find((post) => post.metadata?.event_payload.agent === 'codex');
      if (!claudeAlert || !codexAlert) throw new Error('expected one lobby alert per agent');
      expect(claudeAlert.metadata).toEqual({
        event_type: 'invoker_agent_login',
        event_payload: { host: OWNER_HOST, agent: 'claude' },
      });
      expect(codexAlert.metadata).toEqual({
        event_type: 'invoker_agent_login',
        event_payload: { host: OWNER_HOST, agent: 'codex' },
      });

      await deliverThreadReply(app, {
        channel: LOBBY_CHANNEL,
        threadTs: claudeAlert.ts,
        user: STRANGER,
        text: 'reauth',
      });
      expect(threadPosts(claudeAlert.ts)).toHaveLength(1);
      expect(threadPosts(claudeAlert.ts)[0].text).toBe(NOT_ADMIN_MESSAGE);

      await deliverThreadReply(app, {
        channel: LOBBY_CHANNEL,
        threadTs: claudeAlert.ts,
        user: ADMIN,
        text: 'reauth',
      });
      const claudeStartPost = threadPosts(claudeAlert.ts)[1];
      expect(claudeStartPost.text).toContain('https://claude.ai/oauth/authorize?fake=e2e');

      await deliverThreadReply(app, {
        channel: LOBBY_CHANNEL,
        threadTs: codexAlert.ts,
        user: ADMIN,
        text: 'reauth',
      });
      const codexStartPost = threadPosts(codexAlert.ts)[0];
      expect(codexStartPost.text).toContain('https://github.com/login/device?fake=e2e');
      expect(codexStartPost.text).toContain('WDJB-MJHT');

      await deliverThreadReply(app, {
        channel: LOBBY_CHANNEL,
        threadTs: claudeAlert.ts,
        user: ADMIN,
        text: CLAUDE_CODE,
      });
      const claudeOutcomePost = threadPosts(claudeAlert.ts)[2];
      expect(claudeOutcomePost.text).toContain('installed');

      const secretsContents = readFileSync(secretsPath, 'utf8');
      expect(secretsContents).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${FRESH_CLAUDE_TOKEN}`);
      const secretsBackups = readdirSync(secretsDir).filter((name) => name.startsWith('secrets.env.bak-'));
      expect(secretsBackups).toHaveLength(1);
      expect(readFileSync(join(secretsDir, secretsBackups[0]), 'utf8')).toBe(`CLAUDE_CODE_OAUTH_TOKEN=${OLD_CLAUDE_TOKEN}\n`);

      if (!codexSessionId) throw new Error('expected the codex reauth to have started a login session');
      await waitFor(() => getAgentLoginStatus(codexSessionId!).status === 'installed');
      expect(getAgentLoginStatus(codexSessionId).status).toBe('installed');
      expect(readFileSync(codexAuthPath, 'utf8')).toBe('{"access_token":"valid-token-codex-e2e"}');
      const codexBackups = readdirSync(codexDir).filter((name) => name.startsWith('auth.json.bak-'));
      expect(codexBackups).toHaveLength(1);
      expect(readFileSync(join(codexDir, codexBackups[0]), 'utf8')).toBe(OLD_CODEX_AUTH);

      await worker.tick('manual');
      await Promise.all(pendingAlerts.splice(0));
      expect(alertPosts()).toHaveLength(2);

      for (const message of postedMessages) {
        expect(message.text).not.toContain(FRESH_CLAUDE_TOKEN);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  },
  20_000,
);

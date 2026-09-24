import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { WebClient } from '@slack/web-api';

import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';
import { Channels, LocalBus } from '@invoker/transport';
import { createAgentLoginWatchWorker } from '@invoker/execution-engine';
import { SlackSurface } from '@invoker/surfaces';
import type { SurfaceEvent } from '@invoker/surfaces';

import { runAgentLoginCommand } from '../headless-command-registry.js';

const CODEX_GOOD_TOKEN = 'fake-codex-access-token-e2e';
const CLAUDE_GOOD_TOKEN = 'sk-ant-oat01-e2egoodtoken';

const CODEX_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "login" ] && [ "$2" = "--device-auth" ]; then',
  '  echo "To authenticate, visit: https://example.test/device"',
  '  echo "Enter code: ABCD-1234"',
  '  sleep 0.1',
  `  printf '{"tokens":{"access_token":"${CODEX_GOOD_TOKEN}"}}' > "$CODEX_HOME/auth.json"`,
  '  exit 0',
  'fi',
  'if [ "$1" = "login" ] && [ "$2" = "status" ]; then',
  `  if [ -s "$CODEX_HOME/auth.json" ] && grep -q ${CODEX_GOOD_TOKEN} "$CODEX_HOME/auth.json"; then exit 0; fi`,
  '  exit 1',
  'fi',
  'if [ "$1" = "exec" ]; then',
  '  AUTH_HOME="${CODEX_HOME:-$HOME/.codex}"',
  `  if [ -f "$AUTH_HOME/auth.json" ] && grep -q ${CODEX_GOOD_TOKEN} "$AUTH_HOME/auth.json"; then echo ok; exit 0; fi`,
  '  echo "Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again."',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

const CLAUDE_SCRIPT = [
  '#!/bin/bash',
  'if [ "$1" = "setup-token" ]; then',
  '  echo "Visit this URL to authorize: https://example.test/oauth/authorize?req=demo"',
  '  read -r CODE',
  '  if [ "$CODE" = "GOODCODE" ]; then',
  `    echo "Your Claude Code OAuth token: ${CLAUDE_GOOD_TOKEN}"`,
  '  else',
  '    echo "Invalid code."',
  '  fi',
  '  exit 0',
  'fi',
  'if [ "$1" = "-p" ]; then',
  '  SECRETS="$HOME/.config/invoker/secrets.env"',
  `  if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "${CLAUDE_GOOD_TOKEN}" ]; then echo ok; exit 0; fi`,
  `  if [ -f "$SECRETS" ] && grep -q "CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_GOOD_TOKEN}" "$SECRETS"; then echo ok; exit 0; fi`,
  '  echo "Failed to authenticate: OAuth session expired and could not be refreshed"',
  '  exit 1',
  'fi',
  'exit 1',
  '',
].join('\n');

interface ApiCall {
  method: string;
  channel?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  metadata?: { event_type?: string; event_payload?: Record<string, string> };
}

const apiCalls: ApiCall[] = [];

function wireFakeSlackApp(surface: SlackSurface): (event: { event: Record<string, unknown>; say: (...args: unknown[]) => unknown }) => Promise<unknown> {
  const app = (surface as unknown as { app: Record<string, unknown> }).app;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  app.event = vi.fn((name: string, handler: (...args: unknown[]) => unknown) => {
    handlers.set(name, handler);
  });
  app.command = vi.fn();
  app.action = vi.fn();
  app.stop = vi.fn().mockResolvedValue(undefined);
  app.client = {
    chat: {
      postMessage: vi.fn(
        async ({ channel, text, thread_ts, metadata }: {
          channel: string;
          text: string;
          thread_ts?: string;
          metadata?: ApiCall['metadata'];
        }) => {
          const ts = `${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
          apiCalls.push({ method: 'postMessage', channel, text, ts, thread_ts, metadata });
          return { ts, ok: true };
        },
      ),
    },
    auth: { test: vi.fn().mockResolvedValue({ user_id: 'UBOT123456' }) },
    conversations: { replies: vi.fn().mockResolvedValue({ messages: [] }) },
  };
  (surface as unknown as { botUserId?: string }).botUserId = 'UBOT123456';
  (surface as unknown as { registerMessageHandler(): void }).registerMessageHandler();
  const messageHandler = handlers.get('message');
  if (!messageHandler) throw new Error('message handler was not registered');
  return messageHandler as (event: { event: Record<string, unknown>; say: (...args: unknown[]) => unknown }) => Promise<unknown>;
}

function makeLogger() {
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() };
  logger.child.mockImplementation(() => logger as any);
  return logger as any;
}

function makeStore() {
  const rows = new Map<string, WorkerActionRecord>();
  return {
    rows,
    getWorkerAction(workerKind: string, externalKey: string): WorkerActionRecord | undefined {
      return rows.get(`${workerKind}:${externalKey}`);
    },
    upsertWorkerAction(action: WorkerActionWrite): WorkerActionRecord {
      const record = { ...action } as WorkerActionRecord;
      rows.set(`${action.workerKind}:${action.externalKey}`, record);
      return record;
    },
  };
}

function createFakeBin(name: 'codex' | 'claude', script: string, dir: string): void {
  writeFileSync(join(dir, name), script, { mode: 0o755 });
}

async function waitFor(condition: () => boolean, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition never became true');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function fileContains(path: string, needle: string): boolean {
  try {
    return readFileSync(path, 'utf8').includes(needle);
  } catch {
    return false;
  }
}

const LOBBY_CHANNEL = 'C-LOBBY';
const ADMIN_USER = 'U-ADMIN';
const NON_ADMIN_USER = 'U-RANDO';

describe('agent-login-watch e2e (real worker, real login engine, real SlackSurface)', () => {
  let homeDir: string;
  let fakeBinDir: string;
  let originalPath: string | undefined;
  let originalHome: string | undefined;
  let surface: SlackSurface;
  let unsubscribeForward: () => void;
  let unsubscribeCapture: () => void;
  let apiCallSpy: ReturnType<typeof vi.spyOn>;

  const publishedAlerts: Array<{ alertKey: string; payload: unknown }> = [];

  beforeEach(() => {
    apiCalls.length = 0;
    publishedAlerts.length = 0;
    homeDir = mkdtempSync(join(tmpdir(), 'agent-login-watch-e2e-home-'));
    fakeBinDir = mkdtempSync(join(tmpdir(), 'agent-login-watch-e2e-bin-'));
    createFakeBin('codex', CODEX_SCRIPT, fakeBinDir);
    createFakeBin('claude', CLAUDE_SCRIPT, fakeBinDir);
    originalPath = process.env.PATH;
    originalHome = process.env.HOME;
    process.env.PATH = `${fakeBinDir}:${originalPath}`;
    process.env.HOME = homeDir;
    apiCallSpy = vi.spyOn(WebClient.prototype, 'apiCall').mockResolvedValue({ ok: true, user_id: 'UBOT123456' });
  });

  afterEach(async () => {
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    unsubscribeForward?.();
    unsubscribeCapture?.();
    if (surface) await surface.stop();
    apiCallSpy.mockRestore();
    rmSync(fakeBinDir, { recursive: true, force: true });
    rmSync(homeDir, { recursive: true, force: true });
  });

  async function buildHarness() {
    const messageBus = new LocalBus();
    const store = makeStore();
    const logger = makeLogger();

    surface = new SlackSurface({
      botToken: 'xoxb-test',
      appToken: 'xapp-test',
      signingSecret: 'test-secret',
      channelId: LOBBY_CHANNEL,
      lobbyChannelId: LOBBY_CHANNEL,
      adminUserIds: [ADMIN_USER],
      runHeadlessCommand: (args: string[]) => runAgentLoginCommand(args.slice(1)),
    });
    const messageHandler = wireFakeSlackApp(surface);

    let pending: Promise<void> = Promise.resolve();
    unsubscribeForward = messageBus.subscribe(Channels.SURFACE_EVENT, (message) => {
      pending = pending.then(() => surface.handleEvent(message as SurfaceEvent));
    });
    unsubscribeCapture = messageBus.subscribe(Channels.SURFACE_EVENT, (message) => {
      const event = message as { type?: string; alert?: { alertKey: string; payload: unknown } };
      if (event.type === 'alert' && event.alert) {
        publishedAlerts.push({ alertKey: event.alert.alertKey, payload: event.alert.payload });
      }
    });

    const flush = async (): Promise<void> => {
      await pending;
    };

    return { messageBus, store, logger, flush, messageHandler };
  }

  function agentLoginPosts() {
    return apiCalls.filter((c) => c.metadata?.event_type === 'invoker_agent_login');
  }

  it('takes Codex through a full relogin: alert, admin reauth, real device-auth install, then no new alert', async () => {
    const codexDir = join(homeDir, '.codex');
    mkdirSync(codexDir, { recursive: true });
    const authPath = join(codexDir, 'auth.json');
    writeFileSync(authPath, '{"tokens":{"access_token":"old-live-codex-token"}}');

    const { messageBus, store, logger, flush, messageHandler } = await buildHarness();

    const worker = createAgentLoginWatchWorker({
      logger,
      store,
      messageBus,
      enabled: true,
      tickOnStart: false,
      ownerHostName: 'owner',
      remoteTargets: [],
      agents: ['codex'],
      probeTimeoutMs: 10_000,
    });

    await worker.tick('manual');
    await flush();

    const firstRoundPosts = agentLoginPosts();
    expect(firstRoundPosts).toHaveLength(1);
    expect(firstRoundPosts[0].metadata?.event_payload).toEqual({ host: 'owner', agent: 'codex' });
    expect(publishedAlerts).toHaveLength(1);
    expect(publishedAlerts[0].alertKey).toBe('agent-login:owner:codex');
    const alertTs = firstRoundPosts[0].ts!;

    await messageHandler({
      event: { channel: LOBBY_CHANNEL, thread_ts: alertTs, user: NON_ADMIN_USER, text: 'reauth' },
      say: vi.fn(),
    });
    const refusal = apiCalls.filter((c) => c.thread_ts === alertTs);
    expect(refusal).toHaveLength(1);
    expect(refusal[0].text).toContain('Permission denied');

    await messageHandler({
      event: { channel: LOBBY_CHANNEL, thread_ts: alertTs, user: ADMIN_USER, text: 'reauth' },
      say: vi.fn(),
    });

    const threadPosts = apiCalls.filter((c) => c.thread_ts === alertTs);
    const startPost = threadPosts[threadPosts.length - 1];
    expect(startPost.text).toContain('https://example.test/device');
    expect(startPost.text).toContain('ABCD-1234');

    await waitFor(() => fileContains(authPath, CODEX_GOOD_TOKEN));

    const installedContents = readFileSync(authPath, 'utf8');
    expect(installedContents).toBe(`{"tokens":{"access_token":"${CODEX_GOOD_TOKEN}"}}`);
    const backups = readdirSync(codexDir).filter((name) => name.startsWith('auth.json.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(codexDir, backups[0]), 'utf8')).toBe('{"tokens":{"access_token":"old-live-codex-token"}}');

    await worker.tick('manual');
    await flush();

    expect(agentLoginPosts()).toHaveLength(1);
    expect(publishedAlerts).toHaveLength(1);
    expect(store.rows.get('agent-login-watch:login-probe:owner:codex')?.status).toBe('completed');
    expect(store.rows.get('agent-login-watch:alert-send:agent-login:owner:codex')?.status).toBe('completed');

    const allText = apiCalls.map((c) => c.text ?? '').join('\n');
    expect(allText).not.toContain(CODEX_GOOD_TOKEN);
  }, 30_000);

  it('takes Claude through a full relogin: alert, admin reauth, real setup-token install, then no new alert', async () => {
    const secretsDir = join(homeDir, '.config', 'invoker');
    mkdirSync(secretsDir, { recursive: true });
    const secretsPath = join(secretsDir, 'secrets.env');
    writeFileSync(secretsPath, 'SOME_OTHER_KEY=keep-me\n');

    const { messageBus, store, logger, flush, messageHandler } = await buildHarness();

    const worker = createAgentLoginWatchWorker({
      logger,
      store,
      messageBus,
      enabled: true,
      tickOnStart: false,
      ownerHostName: 'owner',
      remoteTargets: [],
      agents: ['claude'],
      probeTimeoutMs: 10_000,
    });

    await worker.tick('manual');
    await flush();

    const firstRoundPosts = agentLoginPosts();
    expect(firstRoundPosts).toHaveLength(1);
    expect(firstRoundPosts[0].metadata?.event_payload).toEqual({ host: 'owner', agent: 'claude' });
    expect(publishedAlerts).toHaveLength(1);
    expect(publishedAlerts[0].alertKey).toBe('agent-login:owner:claude');
    const alertTs = firstRoundPosts[0].ts!;

    await messageHandler({
      event: { channel: LOBBY_CHANNEL, thread_ts: alertTs, user: ADMIN_USER, text: 'reauth' },
      say: vi.fn(),
    });

    let threadPosts = apiCalls.filter((c) => c.thread_ts === alertTs);
    const startPost = threadPosts[threadPosts.length - 1];
    expect(startPost.text).toContain('https://example.test/oauth/authorize?req=demo');
    expect(startPost.text).toContain('reply in this thread with the code');

    await messageHandler({
      event: { channel: LOBBY_CHANNEL, thread_ts: alertTs, user: ADMIN_USER, text: 'GOODCODE' },
      say: vi.fn(),
    });

    threadPosts = apiCalls.filter((c) => c.thread_ts === alertTs);
    const outcomePost = threadPosts[threadPosts.length - 1];
    expect(outcomePost.text).toContain('installed');

    const secretsContents = readFileSync(secretsPath, 'utf8');
    expect(secretsContents).toContain('SOME_OTHER_KEY=keep-me');
    expect(secretsContents).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_GOOD_TOKEN}`);
    const backups = readdirSync(secretsDir).filter((name) => name.startsWith('secrets.env.bak-'));
    expect(backups).toHaveLength(1);
    expect(readFileSync(join(secretsDir, backups[0]), 'utf8')).toBe('SOME_OTHER_KEY=keep-me\n');

    await worker.tick('manual');
    await flush();

    expect(agentLoginPosts()).toHaveLength(1);
    expect(publishedAlerts).toHaveLength(1);
    expect(store.rows.get('agent-login-watch:login-probe:owner:claude')?.status).toBe('completed');
    expect(store.rows.get('agent-login-watch:alert-send:agent-login:owner:claude')?.status).toBe('completed');

    const allText = apiCalls.map((c) => c.text ?? '').join('\n');
    expect(allText).not.toContain(CLAUDE_GOOD_TOKEN);
  }, 30_000);
});

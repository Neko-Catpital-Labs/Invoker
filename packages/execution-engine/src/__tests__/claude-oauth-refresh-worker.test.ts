import { describe, expect, it, vi } from 'vitest';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDistributeCredentialsScript,
  buildReadCredentialsScript,
  createClaudeOauthRefreshWorker,
  runClaudeAndCodexOauthRefreshCheck,
  runClaudeOauthRefreshCheck,
  runCodexOauthRefreshCheck,
  type ClaudeOauthRefreshTarget,
  type ClaudeOauthRefreshWorkerOptions,
  type CodexOauthRefreshWorkerOptions,
} from '../workers/claude-oauth-refresh-worker.js';
import { CODEX_LAST_REFRESH_MAX_AGE_MS } from '../codex-oauth-refresh.js';
import type { WorkerDecisionStore } from '../worker-decision-ledger.js';

function credentialsJson(expiresAt: number): string {
  return JSON.stringify({
    claudeAiOauth: { accessToken: 'access-old', refreshToken: 'refresh-old', expiresAt, scopes: [] },
  });
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as ClaudeOauthRefreshWorkerOptions['logger'];
}

function makeTarget(name: string): ClaudeOauthRefreshTarget {
  return { name, connection: { host: `${name}.example.test`, user: 'invoker', sshKeyPath: '/tmp/key' } };
}

function makeStore(): { store: WorkerDecisionStore; rows: unknown[] } {
  const rows: unknown[] = [];
  return {
    rows,
    store: {
      getWorkerAction: () => undefined,
      upsertWorkerAction: (action) => { rows.push(action); return action as never; },
    },
  };
}

describe('runClaudeOauthRefreshCheck', () => {
  it('does nothing when the local token and every remote target are all healthy', async () => {
    const writeCredentials = vi.fn();
    const refreshFn = vi.fn();
    const distributeFn = vi.fn();
    const now = Date.now();
    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      readCredentials: () => credentialsJson(now + 60 * 60 * 1000),
      readRemoteCredentials: async () => credentialsJson(now + 60 * 60 * 1000),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    });
    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
  });

  it.fails('records expiring and missing remote Claude credentials without distributing owner credentials', async () => {
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 60 * 60 * 1000);
    const distributeFn = vi.fn(async () => undefined);
    const refreshFn = vi.fn();
    const writeCredentials = vi.fn();
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do2'), makeTarget('do3')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) =>
        target.name === 'do1' ? credentialsJson(now - 1) :
          target.name === 'do2' ? null :
            credentialsJson(now + 60 * 60 * 1000),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    });

    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses).toEqual({ do1: 'failed', do2: 'failed' });
  });

  it.fails('records a remote target holding a logged-out credential file without distributing owner credentials', async () => {
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 7 * 60 * 60 * 1000);
    const loggedOut = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0 } });
    const distributeFn = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async () => loggedOut,
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).not.toHaveBeenCalled();
    expect((rows as { subjectId: string; status: string }[])).toEqual([
      expect.objectContaining({ subjectId: 'do1', status: 'failed' }),
    ]);
  });

  it.fails.each([
    ['an empty object', '{}'],
    ['a null oauth block', JSON.stringify({ claudeAiOauth: null })],
    ['an empty access token with a future expiry', JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: 'r', expiresAt: 1_000_000_000_000 + 60 * 60 * 1000 } })],
    ['unparseable text', 'not json'],
  ])('records a remote target whose file holds %s without distributing owner credentials', async (_label, remoteJson) => {
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 7 * 60 * 60 * 1000);
    const distributeFn = vi.fn(async () => undefined);

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async () => remoteJson,
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).not.toHaveBeenCalled();
  });

  it.fails('records only remote targets that need their own per-host Claude login', async () => {
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 7 * 60 * 60 * 1000);
    const logger = makeLogger();
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger,
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) =>
        target.name === 'do1' ? credentialsJson(0) : credentialsJson(now + 60 * 60 * 1000),
      distributeFn: vi.fn(async () => undefined),
      now: () => now,
    });

    const infoLines = (logger.info as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
    expect(infoLines.some((line) => line.includes('do1') && line.includes('need their own Claude login'))).toBe(true);
    expect(infoLines.some((line) => line.includes('do2') && line.includes('still valid'))).toBe(true);
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses).toEqual({ do1: 'failed' });
  });

  it('never writes to a remote target when the owner credential file holds no usable token', async () => {
    const now = 1_000_000_000_000;
    const logger = makeLogger();
    const distributeFn = vi.fn();
    const refreshFn = vi.fn();
    const readRemoteCredentials = vi.fn(async () => '{}');

    await runClaudeOauthRefreshCheck({
      logger,
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      readCredentials: () => '{}',
      readRemoteCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).not.toHaveBeenCalled();
    expect(refreshFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });

  it.fails('treats a failed remote credential read as a missing per-host login, without stopping other targets', async () => {
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 60 * 60 * 1000);
    const distributeFn = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) => {
        if (target.name === 'do1') throw new Error('ssh: connection refused');
        return credentialsJson(now + 60 * 60 * 1000);
      },
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses).toEqual({ do1: 'failed' });
  });

  it.fails('refreshes and writes the local file without distributing to remote targets when the token is expiring', async () => {
    const now = 1_000_000_000_000;
    const refreshed = credentialsJson(now + 3_600_000);
    const writeCredentials = vi.fn();
    const distributeFn = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do3')],
      store,
      readCredentials: () => credentialsJson(now),
      readRemoteCredentials: async () => credentialsJson(now + 60 * 60 * 1000),
      writeCredentials,
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    });

    expect(writeCredentials).toHaveBeenCalledWith('/home/invoker/.claude/.credentials.json', refreshed);
    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = (rows as { status: string; subjectId: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local:completed');
    expect(statuses).not.toContain('do1:completed');
    expect(statuses).not.toContain('do3:completed');
  });

  it('logs and records a failure without throwing when the refresh request itself fails, leaving existing credentials in place', async () => {
    const logger = makeLogger();
    const writeCredentials = vi.fn();
    const distributeFn = vi.fn();
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger,
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      store,
      readCredentials: () => credentialsJson(1_000_000_000_000),
      writeCredentials,
      refreshFn: async () => null,
      distributeFn,
      now: () => 1_000_000_000_000,
    });

    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    expect((rows as { status: string }[])[0].status).toBe('failed');
  });

  it.fails('records every stale remote target without distributing and without losing the local refresh', async () => {
    const now = 1_000_000_000_000;
    const refreshed = credentialsJson(now + 3_600_000);
    const { store, rows } = makeStore();
    const distributeFn = vi.fn(async () => undefined);

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do6'), makeTarget('do7')],
      store,
      readCredentials: () => credentialsJson(now),
      readRemoteCredentials: async (target) =>
        target.name === 'do7' ? credentialsJson(now + 60 * 60 * 1000) : credentialsJson(now - 1),
      writeCredentials: vi.fn(),
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses.local).toBe('completed');
    expect(statuses.do1).toBe('failed');
    expect(statuses.do6).toBe('failed');
    expect(statuses.do7).toBeUndefined();
  });

  it('fails closed on a local read error without throwing, and never attempts a refresh or distribution', async () => {
    const logger = makeLogger();
    const refreshFn = vi.fn();
    await runClaudeOauthRefreshCheck({
      logger,
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [],
      readCredentials: () => { throw new Error('ENOENT'); },
      refreshFn,
      now: () => Date.now(),
    });
    expect(refreshFn).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
  });
});

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function codexAuthJson(now: number, overrides: { lastRefresh?: string; expSeconds?: number } = {}): string {
  const expSeconds = overrides.expSeconds ?? Math.floor((now + 30 * 60 * 60 * 1000) / 1000);
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwtWithExp(expSeconds),
      refresh_token: 'refresh-old',
    },
    last_refresh: overrides.lastRefresh ?? new Date(now).toISOString(),
  });
}

function makeCodexOptions(overrides: Partial<CodexOauthRefreshWorkerOptions> = {}): CodexOauthRefreshWorkerOptions {
  return {
    logger: makeLogger(),
    authPath: '/home/invoker/.codex/auth.json',
    remoteTargets: [],
    ...overrides,
  };
}

describe('runCodexOauthRefreshCheck', () => {
  it('does nothing when the local token and every remote target are all healthy', async () => {
    const now = 1_000_000_000_000;
    const writeCredentials = vi.fn();
    const refreshFn = vi.fn();
    const distributeFn = vi.fn();
    await runCodexOauthRefreshCheck(makeCodexOptions({
      remoteTargets: [makeTarget('do1')],
      readCredentials: () => codexAuthJson(now),
      readRemoteCredentials: async () => codexAuthJson(now),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    }));
    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
  });

  it.fails('refreshes and writes the local file without distributing to remote targets when the token is expiring', async () => {
    const now = 1_000_000_000_000;
    const refreshed = codexAuthJson(now + 3_600_000);
    const writeCredentials = vi.fn();
    const distributeFn = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runCodexOauthRefreshCheck(makeCodexOptions({
      remoteTargets: [makeTarget('do1'), makeTarget('do3')],
      store,
      readCredentials: () => codexAuthJson(now, { expSeconds: Math.floor(now / 1000) }),
      readRemoteCredentials: async () => codexAuthJson(now),
      writeCredentials,
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    }));

    expect(writeCredentials).toHaveBeenCalledWith('/home/invoker/.codex/auth.json', refreshed);
    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = (rows as { status: string; subjectId: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('codex:local:completed');
    expect(statuses).not.toContain('codex:do1:completed');
    expect(statuses).not.toContain('codex:do3:completed');
  });

  it.fails('records stale and missing remote Codex auth without distributing owner auth', async () => {
    const now = 1_000_000_000_000;
    const healthyLocal = codexAuthJson(now);
    const staleRemote = codexAuthJson(now, {
      lastRefresh: new Date(now - CODEX_LAST_REFRESH_MAX_AGE_MS - 1).toISOString(),
    });
    const distributeFn = vi.fn(async () => undefined);
    const refreshFn = vi.fn();
    const writeCredentials = vi.fn();
    const { store, rows } = makeStore();

    await runCodexOauthRefreshCheck(makeCodexOptions({
      remoteTargets: [makeTarget('do1'), makeTarget('do2'), makeTarget('do3')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) =>
        target.name === 'do1' ? staleRemote :
          target.name === 'do2' ? null :
            codexAuthJson(now),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    }));

    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses).toEqual({ 'codex:do1': 'failed', 'codex:do2': 'failed' });
  });
});

describe('runClaudeAndCodexOauthRefreshCheck', () => {
  it.fails('still runs the Codex pass when Claude refresh fails', async () => {
    const now = 1_000_000_000_000;
    const refreshedCodex = codexAuthJson(now + 3_600_000);
    const writeClaude = vi.fn();
    const writeCodex = vi.fn();
    const distributeClaude = vi.fn();
    const distributeCodex = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runClaudeAndCodexOauthRefreshCheck(
      {
        logger: makeLogger(),
        credentialsPath: '/home/invoker/.claude/.credentials.json',
        remoteTargets: [makeTarget('do1')],
        store,
        readCredentials: () => credentialsJson(now),
        writeCredentials: writeClaude,
        refreshFn: async () => null,
        distributeFn: distributeClaude,
        now: () => now,
      },
      makeCodexOptions({
        remoteTargets: [makeTarget('do1')],
        store,
        readCredentials: () => codexAuthJson(now, { expSeconds: Math.floor(now / 1000) }),
        readRemoteCredentials: async () => codexAuthJson(now),
        writeCredentials: writeCodex,
        refreshFn: async () => refreshedCodex,
        distributeFn: distributeCodex,
        now: () => now,
      }),
    );

    expect(writeClaude).not.toHaveBeenCalled();
    expect(distributeClaude).not.toHaveBeenCalled();
    expect(writeCodex).toHaveBeenCalledWith('/home/invoker/.codex/auth.json', refreshedCodex);
    expect(distributeCodex).not.toHaveBeenCalled();
    const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local:failed');
    expect(statuses).toContain('codex:local:completed');
    expect(statuses).not.toContain('codex:do1:completed');
  });

  it.fails('does not fail the Claude pass when Codex auth.json is missing', async () => {
    const now = 1_000_000_000_000;
    const refreshedClaude = credentialsJson(now + 3_600_000);
    const writeClaude = vi.fn();
    const refreshCodex = vi.fn();
    const distributeCodex = vi.fn();
    const { store, rows } = makeStore();

    await runClaudeAndCodexOauthRefreshCheck(
      {
        logger: makeLogger(),
        credentialsPath: '/home/invoker/.claude/.credentials.json',
        remoteTargets: [makeTarget('do1')],
        store,
        readCredentials: () => credentialsJson(now),
        readRemoteCredentials: async () => credentialsJson(now + 60 * 60 * 1000),
        writeCredentials: writeClaude,
        refreshFn: async () => refreshedClaude,
        distributeFn: vi.fn(async () => undefined),
        now: () => now,
      },
      makeCodexOptions({
        remoteTargets: [makeTarget('do1')],
        store,
        readCredentials: () => { throw new Error('ENOENT'); },
        refreshFn: refreshCodex,
        distributeFn: distributeCodex,
        now: () => now,
      }),
    );

    expect(writeClaude).toHaveBeenCalledWith('/home/invoker/.claude/.credentials.json', refreshedClaude);
    expect(refreshCodex).not.toHaveBeenCalled();
    expect(distributeCodex).not.toHaveBeenCalled();
    const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local:completed');
    expect(statuses).not.toContain('do1:completed');
    expect(statuses.some((s) => s.startsWith('codex:'))).toBe(false);
  });
});

describe('createClaudeOauthRefreshWorker filesystem e2e', () => {
  it.fails('one startup tick refreshes Claude + Codex files on disk without distributing either file', async () => {
    const now = 1_000_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'invoker-oauth-e2e-'));
    const claudePath = join(dir, '.credentials.json');
    const codexPath = join(dir, 'auth.json');
    writeFileSync(claudePath, credentialsJson(now), { mode: 0o600 });
    writeFileSync(codexPath, codexAuthJson(now, { expSeconds: Math.floor(now / 1000) }), { mode: 0o600 });

    const refreshedClaude = credentialsJson(now + 3_600_000);
    const refreshedCodex = codexAuthJson(now + 3_600_000);
    const distributeClaude = vi.fn(async () => undefined);
    const distributeCodex = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    const worker = createClaudeOauthRefreshWorker({
      logger: makeLogger(),
      credentialsPath: claudePath,
      codexAuthPath: codexPath,
      remoteTargets: [makeTarget('do1')],
      store,
      intervalMs: 0,
      tickOnStart: true,
      now: () => now,
      refreshFn: async () => refreshedClaude,
      refreshCodexFn: async () => refreshedCodex,
      readRemoteCredentials: async () => credentialsJson(now + 60 * 60 * 1000),
      readRemoteCodexCredentials: async () => codexAuthJson(now),
      distributeFn: distributeClaude,
      distributeCodexFn: distributeCodex,
    });

    try {
      worker.start();
      await vi.waitFor(() => {
        expect(readFileSync(claudePath, 'utf8')).toBe(refreshedClaude);
        expect(readFileSync(codexPath, 'utf8')).toBe(refreshedCodex);
      });
      expect(distributeClaude).not.toHaveBeenCalled();
      expect(distributeCodex).not.toHaveBeenCalled();
      const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
      expect(statuses).toEqual(expect.arrayContaining([
        'local:completed',
        'codex:local:completed',
      ]));
    } finally {
      await worker.stop({ settleTimeoutMs: 2_000 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('buildDistributeCredentialsScript', () => {
  it('writes the credentials to a temp path and renames atomically into place', () => {
    const script = buildDistributeCredentialsScript('~/.claude/.credentials.json', '{"a":1}');
    expect(script).toContain('mv "$TMP_PATH" "$REMOTE_PATH"');
    expect(script).toContain('chmod 600 "$TMP_PATH"');
  });

  it('writes to and reads from the real home-relative credentials file when run by bash', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-oauth-home-'));
    const cwd = mkdtempSync(join(tmpdir(), 'invoker-oauth-cwd-'));
    const runBash = (script: string) => spawnSync('bash', ['-s'], {
      input: script,
      cwd,
      env: { ...process.env, HOME: home },
      encoding: 'utf8',
    });
    try {
      mkdirSync(join(home, '.claude'));
      writeFileSync(join(home, '.claude', '.credentials.json'), '{"claudeAiOauth":{"accessToken":""}}');

      const read = runBash(buildReadCredentialsScript('~/.claude/.credentials.json'));
      expect(read.status).toBe(0);
      expect(read.stdout).toBe('{"claudeAiOauth":{"accessToken":""}}');

      const write = runBash(buildDistributeCredentialsScript('~/.claude/.credentials.json', '{"a":1}'));
      expect(write.status).toBe(0);
      expect(readFileSync(join(home, '.claude', '.credentials.json'), 'utf8')).toBe('{"a":1}');
      expect(existsSync(join(cwd, '~'))).toBe(false);
      expect(existsSync(join(home, '~'))).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('base64-encodes the content so JSON quoting/special characters never break the remote shell', () => {
    const script = buildDistributeCredentialsScript('/x', '{"token":"a\'b$(rm -rf /)"}');
    expect(script).not.toContain('rm -rf /');
    expect(script).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| invoker_base64_decode/);
  });
});

describe('runClaudeOauthRefreshCheck owner worker credential copy', () => {
  const ownerPath = '/home/invoker/.claude/.credentials.json';
  const workerPath = '/home/invoker/.invoker/claude-worker/.credentials.json';
  const blankWorkerCopy = JSON.stringify({ claudeAiOauth: { accessToken: '', refreshToken: '', expiresAt: 0, scopes: [] } });

  function tokenJson(accessToken: string, expiresAt: number): string {
    return JSON.stringify({ claudeAiOauth: { accessToken, refreshToken: `refresh-${accessToken}`, expiresAt, scopes: [] } });
  }

  function fakeFiles(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    return {
      files,
      readCredentials: (path: string) => {
        const contents = files.get(path);
        if (contents === undefined) throw new Error(`ENOENT: ${path}`);
        return contents;
      },
      writeCredentials: vi.fn((path: string, contents: string) => { files.set(path, contents); }),
    };
  }

  it('reproduces the 2026-09-23 incident: copies a healthy owner token over a blank worker copy', async () => {
    const now = 1_000_000_000_000;
    const owner = tokenJson('owner', now + 4 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: owner, [workerPath]: blankWorkerCopy });
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: workerPath,
      remoteTargets: [],
      store,
      readCredentials: fs.readCredentials,
      writeCredentials: fs.writeCredentials,
      refreshFn: vi.fn(),
      now: () => now,
    });

    expect(fs.files.get(workerPath)).toBe(owner);
    expect(fs.files.get(ownerPath)).toBe(owner);
    const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local-worker-copy:completed');
  });

  it('creates a missing worker copy from the owner token', async () => {
    const now = 1_000_000_000_000;
    const owner = tokenJson('owner', now + 4 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: owner });

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: workerPath,
      remoteTargets: [],
      readCredentials: fs.readCredentials,
      writeCredentials: fs.writeCredentials,
      now: () => now,
    });

    expect(fs.files.get(workerPath)).toBe(owner);
  });

  it.fails('copies a newer worker token back to the owner instead of refreshing with the owner token the CLI already rotated away', async () => {
    const now = 1_000_000_000_000;
    const staleOwner = tokenJson('owner', now);
    const newerWorker = tokenJson('worker', now + 8 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: staleOwner, [workerPath]: newerWorker });
    const refreshFn = vi.fn();
    const distributeFn = vi.fn(async () => undefined);

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: workerPath,
      remoteTargets: [makeTarget('do3')],
      readCredentials: fs.readCredentials,
      readRemoteCredentials: async () => null,
      writeCredentials: fs.writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    });

    expect(refreshFn).not.toHaveBeenCalled();
    expect(fs.files.get(ownerPath)).toBe(newerWorker);
    expect(distributeFn).not.toHaveBeenCalled();
  });

  it('writes a freshly refreshed owner token to the worker copy too', async () => {
    const now = 1_000_000_000_000;
    const expiring = tokenJson('owner', now);
    const refreshed = tokenJson('refreshed', now + 8 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: expiring, [workerPath]: expiring });

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: workerPath,
      remoteTargets: [],
      readCredentials: fs.readCredentials,
      writeCredentials: fs.writeCredentials,
      refreshFn: async () => refreshed,
      now: () => now,
    });

    expect(fs.files.get(ownerPath)).toBe(refreshed);
    expect(fs.files.get(workerPath)).toBe(refreshed);
  });

  it('refreshes ahead of expiry by refreshLeadMs so no CLI process has to rotate the token itself', async () => {
    const now = 1_000_000_000_000;
    const owner = tokenJson('owner', now + 30 * 60 * 1000);
    const refreshed = tokenJson('refreshed', now + 8 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: owner, [workerPath]: owner });
    const refreshFn = vi.fn(async () => refreshed);

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: workerPath,
      refreshLeadMs: 60 * 60 * 1000,
      remoteTargets: [],
      readCredentials: fs.readCredentials,
      writeCredentials: fs.writeCredentials,
      refreshFn,
      now: () => now,
    });

    expect(refreshFn).toHaveBeenCalledTimes(1);
    expect(fs.files.get(workerPath)).toBe(refreshed);
  });

  it('never writes when the worker copy path is the owner path', async () => {
    const now = 1_000_000_000_000;
    const owner = tokenJson('owner', now + 4 * 60 * 60 * 1000);
    const fs = fakeFiles({ [ownerPath]: owner });

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: ownerPath,
      workerCredentialsPath: ownerPath,
      remoteTargets: [],
      readCredentials: fs.readCredentials,
      writeCredentials: fs.writeCredentials,
      now: () => now,
    });

    expect(fs.writeCredentials).not.toHaveBeenCalled();
  });

  it('one on-disk worker tick refreshes early and leaves the owner and worker files holding the same token', async () => {
    const now = 1_000_000_000_000;
    const dir = mkdtempSync(join(tmpdir(), 'invoker-oauth-worker-copy-'));
    const ownerFile = join(dir, 'claude', '.credentials.json');
    const workerFile = join(dir, 'claude-worker', '.credentials.json');
    mkdirSync(join(dir, 'claude'), { recursive: true });
    writeFileSync(ownerFile, tokenJson('owner', now + 30 * 60 * 1000), { mode: 0o600 });
    const refreshed = tokenJson('refreshed', now + 8 * 60 * 60 * 1000);

    const worker = createClaudeOauthRefreshWorker({
      logger: makeLogger(),
      credentialsPath: ownerFile,
      workerCredentialsPath: workerFile,
      codexAuthPath: join(dir, 'missing-codex-auth.json'),
      remoteTargets: [],
      intervalMs: 60 * 60 * 1000,
      tickOnStart: true,
      now: () => now,
      refreshFn: async () => refreshed,
    });

    try {
      worker.start();
      await vi.waitFor(() => {
        expect(existsSync(workerFile)).toBe(true);
        expect(readFileSync(ownerFile, 'utf8')).toBe(refreshed);
        expect(readFileSync(workerFile, 'utf8')).toBe(refreshed);
      });
    } finally {
      await worker.stop({ settleTimeoutMs: 2_000 });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

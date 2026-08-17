import { describe, expect, it, vi } from 'vitest';

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDistributeCredentialsScript,
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

  it('reproduces the real incident: distributes current credentials to a remote target whose own copy is expiring, even when the local token is healthy', async () => {
    // Real incident, 2026-08-16: the owner's own credentials stayed healthy
    // (refreshed by its own live CLI usage) while all 5 SSH pool targets
    // independently expired. The worker never fired because the entire
    // check -- local refresh AND remote distribution -- was gated on the
    // local token's own expiry alone.
    const now = 1_000_000_000_000;
    const healthyLocal = credentialsJson(now + 60 * 60 * 1000);
    const distributeFn = vi.fn(async () => undefined);
    const refreshFn = vi.fn();
    const writeCredentials = vi.fn();
    const { store, rows } = makeStore();

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) =>
        target.name === 'do1' ? credentialsJson(now - 1) : credentialsJson(now + 60 * 60 * 1000),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    });

    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).toHaveBeenCalledTimes(1);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), healthyLocal);
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses.do1).toBe('completed');
    expect(statuses.do2).toBeUndefined();
  });

  it('treats a failed remote credential read as needing distribution, without stopping other targets', async () => {
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

    expect(distributeFn).toHaveBeenCalledTimes(1);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), healthyLocal);
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses.do1).toBe('completed');
    expect(statuses.do2).toBeUndefined();
  });

  it('refreshes, writes the local file, and distributes to every remote target when the token is expiring', async () => {
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
      writeCredentials,
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    });

    expect(writeCredentials).toHaveBeenCalledWith('/home/invoker/.claude/.credentials.json', refreshed);
    expect(distributeFn).toHaveBeenCalledTimes(2);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), refreshed);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do3' }), refreshed);
    const statuses = (rows as { status: string; subjectId: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local:completed');
    expect(statuses).toContain('do1:completed');
    expect(statuses).toContain('do3:completed');
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

  it('reproduces the real incident: one remote target failing to distribute must not stop the others or lose the local refresh', async () => {
    // Real incident tonight: 6 SSH pool machines all had "OAuth session
    // expired" simultaneously. A worker that gave up after the first failed
    // distribution would leave every other machine stuck too.
    const now = 1_000_000_000_000;
    const refreshed = credentialsJson(now + 3_600_000);
    const { store, rows } = makeStore();
    const distributeFn = vi.fn(async (target: ClaudeOauthRefreshTarget) => {
      if (target.name === 'do6') throw new Error('ssh: connection refused');
    });

    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1'), makeTarget('do6'), makeTarget('do7')],
      store,
      readCredentials: () => credentialsJson(now),
      writeCredentials: vi.fn(),
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    });

    expect(distributeFn).toHaveBeenCalledTimes(3);
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses.do1).toBe('completed');
    expect(statuses.do7).toBe('completed');
    expect(statuses.do6).toBe('failed');
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
  const expSeconds = overrides.expSeconds ?? Math.floor((now + 60 * 60 * 1000) / 1000);
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

  it('refreshes, writes the local file, and distributes to every remote target when the token is expiring', async () => {
    const now = 1_000_000_000_000;
    const refreshed = codexAuthJson(now + 3_600_000);
    const writeCredentials = vi.fn();
    const distributeFn = vi.fn(async () => undefined);
    const { store, rows } = makeStore();

    await runCodexOauthRefreshCheck(makeCodexOptions({
      remoteTargets: [makeTarget('do1'), makeTarget('do3')],
      store,
      readCredentials: () => codexAuthJson(now, { expSeconds: Math.floor(now / 1000) }),
      writeCredentials,
      refreshFn: async () => refreshed,
      distributeFn,
      now: () => now,
    }));

    expect(writeCredentials).toHaveBeenCalledWith('/home/invoker/.codex/auth.json', refreshed);
    expect(distributeFn).toHaveBeenCalledTimes(2);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), refreshed);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do3' }), refreshed);
    const statuses = (rows as { status: string; subjectId: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('codex:local:completed');
    expect(statuses).toContain('codex:do1:completed');
    expect(statuses).toContain('codex:do3:completed');
  });

  it('distributes current Codex auth to a remote target whose own copy is stale, even when the local token is healthy', async () => {
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
      remoteTargets: [makeTarget('do1'), makeTarget('do2')],
      store,
      readCredentials: () => healthyLocal,
      readRemoteCredentials: async (target) =>
        target.name === 'do1' ? staleRemote : codexAuthJson(now),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => now,
    }));

    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).toHaveBeenCalledTimes(1);
    expect(distributeFn).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), healthyLocal);
    const statuses = Object.fromEntries((rows as { subjectId: string; status: string }[]).map((r) => [r.subjectId, r.status]));
    expect(statuses['codex:do1']).toBe('completed');
    expect(statuses['codex:do2']).toBeUndefined();
  });
});

describe('runClaudeAndCodexOauthRefreshCheck', () => {
  it('still runs the Codex pass when Claude refresh fails', async () => {
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
        writeCredentials: writeCodex,
        refreshFn: async () => refreshedCodex,
        distributeFn: distributeCodex,
        now: () => now,
      }),
    );

    expect(writeClaude).not.toHaveBeenCalled();
    expect(distributeClaude).not.toHaveBeenCalled();
    expect(writeCodex).toHaveBeenCalledWith('/home/invoker/.codex/auth.json', refreshedCodex);
    expect(distributeCodex).toHaveBeenCalledTimes(1);
    const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
    expect(statuses).toContain('local:failed');
    expect(statuses).toContain('codex:local:completed');
    expect(statuses).toContain('codex:do1:completed');
  });

  it('does not fail the Claude pass when Codex auth.json is missing', async () => {
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
    expect(statuses).toContain('do1:completed');
    expect(statuses.some((s) => s.startsWith('codex:'))).toBe(false);
  });
});

describe('createClaudeOauthRefreshWorker filesystem e2e', () => {
  it('one startup tick refreshes Claude + Codex files on disk and distributes both independently', async () => {
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
      distributeFn: distributeClaude,
      distributeCodexFn: distributeCodex,
    });

    try {
      worker.start();
      await vi.waitFor(() => {
        expect(readFileSync(claudePath, 'utf8')).toBe(refreshedClaude);
        expect(readFileSync(codexPath, 'utf8')).toBe(refreshedCodex);
      });
      expect(distributeClaude).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), refreshedClaude);
      expect(distributeCodex).toHaveBeenCalledWith(expect.objectContaining({ name: 'do1' }), refreshedCodex);
      const statuses = (rows as { subjectId: string; status: string }[]).map((r) => `${r.subjectId}:${r.status}`);
      expect(statuses).toEqual(expect.arrayContaining([
        'local:completed',
        'do1:completed',
        'codex:local:completed',
        'codex:do1:completed',
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
    expect(script).toContain('REMOTE_PATH="~/.claude/.credentials.json"');
    expect(script).toContain('mv "$TMP_PATH" "$REMOTE_PATH"');
    expect(script).toContain('chmod 600 "$TMP_PATH"');
  });

  it('base64-encodes the content so JSON quoting/special characters never break the remote shell', () => {
    const script = buildDistributeCredentialsScript('/x', '{"token":"a\'b$(rm -rf /)"}');
    expect(script).not.toContain('rm -rf /');
    expect(script).toMatch(/printf '%s' '[A-Za-z0-9+/=]+' \| invoker_base64_decode/);
  });
});

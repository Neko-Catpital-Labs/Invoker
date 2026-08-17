import { describe, expect, it, vi } from 'vitest';

import {
  buildDistributeCredentialsScript,
  runClaudeOauthRefreshCheck,
  type ClaudeOauthRefreshTarget,
  type ClaudeOauthRefreshWorkerOptions,
} from '../workers/claude-oauth-refresh-worker.js';
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
  it('does nothing when the token is not close to expiring', async () => {
    const writeCredentials = vi.fn();
    const refreshFn = vi.fn();
    const distributeFn = vi.fn();
    await runClaudeOauthRefreshCheck({
      logger: makeLogger(),
      credentialsPath: '/home/invoker/.claude/.credentials.json',
      remoteTargets: [makeTarget('do1')],
      readCredentials: () => credentialsJson(Date.now() + 60 * 60 * 1000),
      writeCredentials,
      refreshFn,
      distributeFn,
      now: () => Date.now(),
    });
    expect(refreshFn).not.toHaveBeenCalled();
    expect(writeCredentials).not.toHaveBeenCalled();
    expect(distributeFn).not.toHaveBeenCalled();
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

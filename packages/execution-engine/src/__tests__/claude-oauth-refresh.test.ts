import { describe, expect, it } from 'vitest';

import {
  applyRefreshedToken,
  isOauthTokenExpiring,
  OAUTH_EXPIRY_BUFFER_MS,
  parseClaudeOauthBlob,
  readRefreshToken,
  refreshClaudeOauthCredentials,
} from '../claude-oauth-refresh.js';

function credentialsJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    claudeAiOauth: {
      accessToken: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: 1_800_000_000_000,
      scopes: ['user:inference'],
      ...overrides,
    },
  });
}

describe('parseClaudeOauthBlob', () => {
  it('returns the claudeAiOauth block from valid JSON', () => {
    expect(parseClaudeOauthBlob(credentialsJson())).toMatchObject({ accessToken: 'access-old' });
  });

  it('returns null for unparseable JSON', () => {
    expect(parseClaudeOauthBlob('not json')).toBeNull();
  });

  it('returns null when claudeAiOauth is absent', () => {
    expect(parseClaudeOauthBlob(JSON.stringify({ other: 1 }))).toBeNull();
  });

  it('returns null when claudeAiOauth is an array, not an object', () => {
    expect(parseClaudeOauthBlob(JSON.stringify({ claudeAiOauth: [] }))).toBeNull();
  });
});

describe('readRefreshToken', () => {
  it('returns the stored refresh token', () => {
    expect(readRefreshToken(credentialsJson())).toBe('refresh-old');
  });

  it('returns null when the refresh token is blank', () => {
    expect(readRefreshToken(credentialsJson({ refreshToken: '  ' }))).toBeNull();
  });

  it('returns null when credentials are unparseable', () => {
    expect(readRefreshToken('not json')).toBeNull();
  });
});

describe('isOauthTokenExpiring', () => {
  const now = 1_800_000_000_000 - OAUTH_EXPIRY_BUFFER_MS - 1000;

  it('is false when the token has more than the buffer left', () => {
    expect(isOauthTokenExpiring(credentialsJson(), now)).toBe(false);
  });

  it('is true once inside the refresh buffer', () => {
    expect(isOauthTokenExpiring(credentialsJson(), now + 2000)).toBe(true);
  });

  it('is true when expiresAt is missing, so a blob with no expiry metadata still gets refreshed proactively', () => {
    expect(isOauthTokenExpiring(credentialsJson({ expiresAt: undefined }), now)).toBe(true);
  });

  it('is false when there is no claudeAiOauth block at all (nothing to refresh)', () => {
    expect(isOauthTokenExpiring(JSON.stringify({}), now)).toBe(false);
  });
});

describe('applyRefreshedToken', () => {
  it('overwrites accessToken/expiresAt/scope and preserves the refresh token when the server does not rotate it', () => {
    const result = applyRefreshedToken(
      credentialsJson(),
      { access_token: 'access-new', expires_in: 3600, scope: 'user:inference user:profile' },
      1_000_000_000_000,
    );
    const parsed = JSON.parse(result!);
    expect(parsed.claudeAiOauth).toMatchObject({
      accessToken: 'access-new',
      expiresAt: 1_000_000_000_000 + 3_600_000,
      refreshToken: 'refresh-old',
      scopes: ['user:inference', 'user:profile'],
    });
  });

  it('rotates the refresh token when the server issues a new single-use one', () => {
    const result = applyRefreshedToken(
      credentialsJson(),
      { access_token: 'access-new', refresh_token: 'refresh-new' },
      1_000_000_000_000,
    );
    expect(JSON.parse(result!).claudeAiOauth.refreshToken).toBe('refresh-new');
  });

  it('preserves every other top-level field the caller already had', () => {
    const withExtra = JSON.stringify({ claudeAiOauth: JSON.parse(credentialsJson()).claudeAiOauth, otherField: 'keep-me' });
    const result = applyRefreshedToken(withExtra, { access_token: 'access-new' });
    expect(JSON.parse(result!).otherField).toBe('keep-me');
  });

  it('returns null when the response has no usable access_token', () => {
    expect(applyRefreshedToken(credentialsJson(), {})).toBeNull();
    expect(applyRefreshedToken(credentialsJson(), { access_token: '  ' })).toBeNull();
  });

  it('returns null for unparseable input JSON', () => {
    expect(applyRefreshedToken('not json', { access_token: 'x' })).toBeNull();
  });
});

describe('refreshClaudeOauthCredentials', () => {
  it('posts grant_type=refresh_token with the stored token and returns updated credentials on success', async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const result = await refreshClaudeOauthCredentials(credentialsJson(), {
      now: 1_000_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access-new', expires_in: 3600, refresh_token: 'refresh-new' }),
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://platform.claude.com/v1/oauth/token');
    const body = (calls[0].init as { body: string }).body;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=refresh-old');
    const parsed = JSON.parse(result!);
    expect(parsed.claudeAiOauth.accessToken).toBe('access-new');
    expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-new');
  });

  it('returns null without making a network call when there is no refresh token to send', async () => {
    let called = false;
    const result = await refreshClaudeOauthCredentials(JSON.stringify({}), {
      fetchFn: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  it('returns null on a non-2xx response instead of throwing', async () => {
    const result = await refreshClaudeOauthCredentials(credentialsJson(), {
      fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) }),
    });
    expect(result).toBeNull();
  });

  it('returns null when the network call itself throws, so a transient outage never crashes the caller', async () => {
    const result = await refreshClaudeOauthCredentials(credentialsJson(), {
      fetchFn: async () => { throw new Error('ECONNRESET'); },
    });
    expect(result).toBeNull();
  });
});

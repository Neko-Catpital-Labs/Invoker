import { describe, expect, it } from 'vitest';

import { OAUTH_EXPIRY_BUFFER_MS } from '../claude-oauth-refresh.js';
import {
  applyRefreshedCodexToken,
  CODEX_LAST_REFRESH_MAX_AGE_MS,
  isCodexAuthExpiring,
  parseCodexAuthFile,
  readCodexRefreshToken,
  refreshCodexOauthCredentials,
  resolveCodexAuthPath,
  resolveCodexRefreshTokenUrl,
} from '../codex-oauth-refresh.js';

function jwtWithExp(expSeconds: number): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url');
  return `${header}.${payload}.sig`;
}

function authJson(overrides: {
  refreshToken?: string;
  accessToken?: string;
  lastRefresh?: string | number;
  extra?: Record<string, unknown>;
} = {}): string {
  return JSON.stringify({
    auth_mode: 'chatgpt',
    tokens: {
      access_token: overrides.accessToken ?? jwtWithExp(2_000_000_000),
      id_token: 'id-old',
      refresh_token: overrides.refreshToken ?? 'refresh-old',
    },
    last_refresh: overrides.lastRefresh ?? '2026-01-01T00:00:00.000Z',
    ...(overrides.extra ?? {}),
  });
}

describe('resolveCodexAuthPath', () => {
  it('prefers INVOKER_CODEX_AUTH_PATH over CODEX_HOME', () => {
    expect(resolveCodexAuthPath({
      INVOKER_CODEX_AUTH_PATH: '/tmp/custom-auth.json',
      CODEX_HOME: '/tmp/codex-home',
    })).toBe('/tmp/custom-auth.json');
  });

  it('joins CODEX_HOME/auth.json when no explicit path is set', () => {
    expect(resolveCodexAuthPath({ CODEX_HOME: '/tmp/codex-home' })).toBe('/tmp/codex-home/auth.json');
  });
});

describe('resolveCodexRefreshTokenUrl', () => {
  it('honors CODEX_REFRESH_TOKEN_URL_OVERRIDE', () => {
    expect(resolveCodexRefreshTokenUrl({
      CODEX_REFRESH_TOKEN_URL_OVERRIDE: 'https://example.test/oauth/token',
    })).toBe('https://example.test/oauth/token');
  });
});

describe('parseCodexAuthFile / readCodexRefreshToken', () => {
  it('returns the stored refresh token', () => {
    expect(parseCodexAuthFile(authJson())?.auth_mode).toBe('chatgpt');
    expect(readCodexRefreshToken(authJson())).toBe('refresh-old');
  });

  it('returns null for unparseable JSON or a blank refresh token', () => {
    expect(parseCodexAuthFile('not json')).toBeNull();
    expect(readCodexRefreshToken(authJson({ refreshToken: '  ' }))).toBeNull();
  });
});

describe('isCodexAuthExpiring', () => {
  const now = 1_800_000_000_000;

  it('is false for API-key files with no refresh token', () => {
    expect(isCodexAuthExpiring(JSON.stringify({ openai_api_key: 'sk-test' }), now)).toBe(false);
  });

  it('is true when the access-token JWT is inside the refresh buffer', () => {
    const expSeconds = Math.floor((now + OAUTH_EXPIRY_BUFFER_MS - 1000) / 1000);
    expect(isCodexAuthExpiring(authJson({
      accessToken: jwtWithExp(expSeconds),
      lastRefresh: new Date(now).toISOString(),
    }), now)).toBe(true);
  });

  it('is false when the JWT has more than the buffer left and last_refresh is recent', () => {
    const expSeconds = Math.floor((now + OAUTH_EXPIRY_BUFFER_MS + 60_000) / 1000);
    expect(isCodexAuthExpiring(authJson({
      accessToken: jwtWithExp(expSeconds),
      lastRefresh: new Date(now).toISOString(),
    }), now)).toBe(false);
  });

  it('is true when last_refresh is older than seven days', () => {
    const expSeconds = Math.floor((now + 60 * 60 * 1000) / 1000);
    expect(isCodexAuthExpiring(authJson({
      accessToken: jwtWithExp(expSeconds),
      lastRefresh: new Date(now - CODEX_LAST_REFRESH_MAX_AGE_MS - 1).toISOString(),
    }), now)).toBe(true);
  });

  it('is true when expiry metadata is missing or unparseable', () => {
    expect(isCodexAuthExpiring(JSON.stringify({
      tokens: { refresh_token: 'refresh-old', access_token: 'not-a-jwt' },
    }), now)).toBe(true);
  });
});

describe('applyRefreshedCodexToken', () => {
  it('overwrites access_token, rotates refresh_token, and stamps last_refresh', () => {
    const result = applyRefreshedCodexToken(
      authJson({ extra: { keep: 'me' } }),
      { access_token: 'access-new', id_token: 'id-new', refresh_token: 'refresh-new' },
      1_000_000_000_000,
    );
    const parsed = JSON.parse(result!);
    expect(parsed.keep).toBe('me');
    expect(parsed.tokens).toMatchObject({
      access_token: 'access-new',
      id_token: 'id-new',
      refresh_token: 'refresh-new',
    });
    expect(parsed.last_refresh).toBe(new Date(1_000_000_000_000).toISOString());
  });

  it('keeps the existing refresh token when the server does not rotate it', () => {
    const result = applyRefreshedCodexToken(authJson(), { access_token: 'access-new' });
    expect(JSON.parse(result!).tokens.refresh_token).toBe('refresh-old');
  });

  it('returns null when the response has no usable access_token', () => {
    expect(applyRefreshedCodexToken(authJson(), {})).toBeNull();
    expect(applyRefreshedCodexToken('not json', { access_token: 'x' })).toBeNull();
  });
});

describe('refreshCodexOauthCredentials', () => {
  it('posts JSON grant_type=refresh_token and returns updated credentials on success', async () => {
    const calls: Array<{ url: string; init: unknown }> = [];
    const result = await refreshCodexOauthCredentials(authJson(), {
      now: 1_000_000_000_000,
      fetchFn: async (url, init) => {
        calls.push({ url, init });
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new' }),
        };
      },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://auth.openai.com/oauth/token');
    expect(JSON.parse((calls[0].init as { body: string }).body)).toEqual({
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      grant_type: 'refresh_token',
      refresh_token: 'refresh-old',
    });
    expect(JSON.parse(result!).tokens.access_token).toBe('access-new');
    expect(JSON.parse(result!).tokens.refresh_token).toBe('refresh-new');
  });

  it('returns null without a network call when there is no refresh token', async () => {
    let called = false;
    const result = await refreshCodexOauthCredentials(JSON.stringify({ openai_api_key: 'sk-test' }), {
      fetchFn: async () => { called = true; return { ok: true, status: 200, json: async () => ({}) }; },
    });
    expect(called).toBe(false);
    expect(result).toBeNull();
  });

  it('returns null on a non-2xx response or a thrown network error', async () => {
    expect(await refreshCodexOauthCredentials(authJson(), {
      fetchFn: async () => ({ ok: false, status: 401, json: async () => ({ error: 'invalid_grant' }) }),
    })).toBeNull();
    expect(await refreshCodexOauthCredentials(authJson(), {
      fetchFn: async () => { throw new Error('ECONNRESET'); },
    })).toBeNull();
  });
});

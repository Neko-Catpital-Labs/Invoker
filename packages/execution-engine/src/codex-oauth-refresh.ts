import { homedir } from 'node:os';
import { join } from 'node:path';

import { OAUTH_EXPIRY_BUFFER_MS, type OauthFetchFn } from './claude-oauth-refresh.js';

const DEFAULT_OAUTH_TOKEN_URL = 'https://auth.openai.com/oauth/token';
// Public Codex CLI OAuth client id — not a secret, the same value the
// `codex` CLI itself sends on every refresh request.
const OAUTH_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const REFRESH_TIMEOUT_MS = 10_000;
export const CODEX_LAST_REFRESH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

interface CodexTokenBlob {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
  [key: string]: unknown;
}

interface CodexAuthFile {
  tokens?: CodexTokenBlob;
  last_refresh?: unknown;
  [key: string]: unknown;
}

interface CodexTokenEndpointResponse {
  access_token?: unknown;
  id_token?: unknown;
  refresh_token?: unknown;
}

export function resolveCodexAuthPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.INVOKER_CODEX_AUTH_PATH?.trim();
  if (override) return override;
  const home = env.CODEX_HOME?.trim() || join(homedir(), '.codex');
  return join(home, 'auth.json');
}

export function resolveCodexRefreshTokenUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_REFRESH_TOKEN_URL_OVERRIDE?.trim() || DEFAULT_OAUTH_TOKEN_URL;
}

export function parseCodexAuthFile(authJson: string): CodexAuthFile | null {
  try {
    const parsed = JSON.parse(authJson) as CodexAuthFile;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function readCodexRefreshToken(authJson: string): string | null {
  const parsed = parseCodexAuthFile(authJson);
  const token = parsed?.tokens?.refresh_token;
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

function readJwtExpMs(accessToken: string): number | null {
  const parts = accessToken.split('.');
  if (parts.length < 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as { exp?: unknown };
    if (typeof payload.exp !== 'number' || !Number.isFinite(payload.exp)) return null;
    return payload.exp * 1000;
  } catch {
    return null;
  }
}

function readLastRefreshMs(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * True when a ChatGPT-login Codex auth blob should be refreshed. API-key
 * files (no refresh token) are never treated as expiring. A missing or
 * unparseable expiry is treated as "needs refresh".
 */
export function isCodexAuthExpiring(authJson: string, now: number = Date.now()): boolean {
  if (!readCodexRefreshToken(authJson)) return false;
  const parsed = parseCodexAuthFile(authJson);
  const accessToken = parsed?.tokens?.access_token;
  const jwtExpMs = typeof accessToken === 'string' ? readJwtExpMs(accessToken) : null;
  const lastRefreshMs = readLastRefreshMs(parsed?.last_refresh);
  if (jwtExpMs === null && lastRefreshMs === null) return true;
  if (jwtExpMs !== null && now + OAUTH_EXPIRY_BUFFER_MS >= jwtExpMs) return true;
  if (lastRefreshMs !== null && now - lastRefreshMs >= CODEX_LAST_REFRESH_MAX_AGE_MS) return true;
  return false;
}

export function applyRefreshedCodexToken(
  authJson: string,
  response: CodexTokenEndpointResponse,
  now: number = Date.now(),
): string | null {
  const parsed = parseCodexAuthFile(authJson);
  if (!parsed) return null;
  const accessToken = response.access_token;
  if (typeof accessToken !== 'string' || accessToken.trim() === '') return null;

  const tokens: CodexTokenBlob = { ...parsed.tokens };
  tokens.access_token = accessToken;
  if (typeof response.id_token === 'string' && response.id_token.trim() !== '') {
    tokens.id_token = response.id_token;
  }
  if (typeof response.refresh_token === 'string' && response.refresh_token.trim() !== '') {
    tokens.refresh_token = response.refresh_token;
  }
  parsed.tokens = tokens;
  parsed.last_refresh = new Date(now).toISOString();
  return JSON.stringify(parsed);
}

export async function refreshCodexOauthCredentials(
  authJson: string,
  opts: { fetchFn?: OauthFetchFn; now?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<string | null> {
  const refreshToken = readCodexRefreshToken(authJson);
  if (!refreshToken) return null;

  const fetchFn = opts.fetchFn ?? (globalThis.fetch as OauthFetchFn | undefined);
  if (!fetchFn) return null;
  const now = opts.now ?? Date.now();

  try {
    const res = await fetchFn(resolveCodexRefreshTokenUrl(opts.env), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: OAUTH_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json() as CodexTokenEndpointResponse;
    return applyRefreshedCodexToken(authJson, body, now);
  } catch {
    return null;
  }
}

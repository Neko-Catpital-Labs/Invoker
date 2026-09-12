// Refreshes a Claude Code OAuth credential blob directly against Anthropic's
// token endpoint, instead of relying on the `claude` CLI to refresh itself
// and scraping the result back out -- that path can copy a refresh token
// that the CLI already burned (Anthropic issues single-use refresh tokens),
// stranding a stale credential. Owning the refresh means Invoker persists
// the rotated refresh token atomically, the same way the credential is
// actually meant to be rotated.
const OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';
// Public Claude Code OAuth client id -- not a secret, the same value the
// `claude` CLI itself sends on every refresh request.
const OAUTH_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

// Refresh slightly ahead of expiry so a task launch never races a token that
// dies mid-flight. Matches the CLI's own refresh skew.
export const OAUTH_EXPIRY_BUFFER_MS = 5 * 60 * 1000;
const REFRESH_TIMEOUT_MS = 10_000;

interface ClaudeOauthBlob {
  accessToken?: unknown;
  refreshToken?: unknown;
  expiresAt?: unknown;
  scopes?: unknown;
  [key: string]: unknown;
}

interface ClaudeCredentials {
  claudeAiOauth?: ClaudeOauthBlob;
  [key: string]: unknown;
}

interface TokenEndpointResponse {
  access_token?: unknown;
  expires_in?: unknown;
  refresh_token?: unknown;
  scope?: unknown;
}

/** Parses the `claudeAiOauth` block out of a credentials JSON string, or null if absent/unparseable. */
export function parseClaudeOauthBlob(credentialsJson: string): ClaudeOauthBlob | null {
  try {
    const parsed = JSON.parse(credentialsJson) as ClaudeCredentials;
    const oauth = parsed?.claudeAiOauth;
    return oauth && typeof oauth === 'object' && !Array.isArray(oauth) ? oauth : null;
  } catch {
    return null;
  }
}

export function readRefreshToken(credentialsJson: string): string | null {
  const oauth = parseClaudeOauthBlob(credentialsJson);
  const token = oauth?.refreshToken;
  return typeof token === 'string' && token.trim() !== '' ? token.trim() : null;
}

/**
 * True when the stored access token is already expired or within the
 * refresh buffer. A missing/non-numeric expiresAt is treated as
 * "needs refresh" rather than trusted indefinitely.
 */
export function isOauthTokenExpiring(credentialsJson: string, now: number = Date.now()): boolean {
  const oauth = parseClaudeOauthBlob(credentialsJson);
  if (!oauth) return false;
  const expiresAt = oauth.expiresAt;
  if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return true;
  return now + OAUTH_EXPIRY_BUFFER_MS >= expiresAt;
}

/**
 * Merges a token-endpoint response into stored credentials JSON, preserving
 * every field the caller already had and only overwriting what the response
 * provides. Returns null on malformed input or a missing access token.
 */
export function applyRefreshedToken(
  credentialsJson: string,
  response: TokenEndpointResponse,
  now: number = Date.now(),
): string | null {
  let parsed: ClaudeCredentials;
  try {
    parsed = JSON.parse(credentialsJson) as ClaudeCredentials;
  } catch {
    return null;
  }
  const accessToken = response.access_token;
  if (typeof accessToken !== 'string' || accessToken.trim() === '') return null;

  const oauth: ClaudeOauthBlob = { ...parsed.claudeAiOauth };
  oauth.accessToken = accessToken;
  if (typeof response.expires_in === 'number' && Number.isFinite(response.expires_in)) {
    oauth.expiresAt = now + response.expires_in * 1000;
  }
  // Anthropic issues single-use refresh tokens; persisting the rotated value
  // is the entire point of owning this refresh instead of scraping the CLI.
  if (typeof response.refresh_token === 'string' && response.refresh_token.trim() !== '') {
    oauth.refreshToken = response.refresh_token;
  }
  if (typeof response.scope === 'string' && response.scope.trim() !== '') {
    oauth.scopes = response.scope.split(' ');
  }
  parsed.claudeAiOauth = oauth;
  return JSON.stringify(parsed);
}

export type OauthFetchFn = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body: string;
  signal?: AbortSignal;
}) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * Refreshes the OAuth token for a stored credentials blob against
 * Anthropic's token endpoint. Returns the updated credentials JSON on
 * success, or null on any failure (no refresh token present, network error,
 * non-2xx response, malformed response body). Never throws -- callers treat
 * null as "keep the existing credentials," so a transient failure here is
 * never worse than not refreshing at all.
 */
export async function refreshClaudeOauthCredentials(
  credentialsJson: string,
  opts: { fetchFn?: OauthFetchFn; now?: number } = {},
): Promise<string | null> {
  const refreshToken = readRefreshToken(credentialsJson);
  if (!refreshToken) return null;

  const fetchFn = opts.fetchFn ?? (globalThis.fetch as OauthFetchFn | undefined);
  if (!fetchFn) return null;
  const now = opts.now ?? Date.now();

  try {
    const res = await fetchFn(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: OAUTH_CLIENT_ID,
      }).toString(),
      signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = await res.json() as TokenEndpointResponse;
    return applyRefreshedToken(credentialsJson, body, now);
  } catch {
    return null;
  }
}

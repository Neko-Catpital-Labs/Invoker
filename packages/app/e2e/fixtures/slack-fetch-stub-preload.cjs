'use strict';

/**
 * Node `--require` preload: monkeypatches the global `fetch` so the CLI's
 * `validateSlackCredentials()` (packages/cli/src/onboarding.ts), which calls
 * the real global `fetch` against slack.com, resolves deterministically
 * instead of hitting the network. Only active when
 * INVOKER_TEST_SLACK_FETCH_STUB is set (e2e-only, never referenced by
 * product code).
 */

const raw = process.env.INVOKER_TEST_SLACK_FETCH_STUB;

if (raw) {
  const stub = JSON.parse(raw);
  const realFetch = globalThis.fetch;

  const jsonResponse = (body) => ({
    json: async () => body,
    headers: {
      get: (name) => (name.toLowerCase() === 'x-oauth-scopes' ? (body.scopes ?? null) : null),
    },
  });

  globalThis.fetch = async (url, init) => {
    const href = String(url);
    if (href.startsWith('https://slack.com/api/auth.test')) {
      return jsonResponse(stub.authTest ?? { ok: false, error: 'invalid_auth' });
    }
    if (href.startsWith('https://slack.com/api/apps.connections.open')) {
      return jsonResponse(stub.connectionsOpen ?? { ok: false, error: 'invalid_auth' });
    }
    if (href.startsWith('https://slack.com/api/conversations.info')) {
      return jsonResponse(stub.conversationsInfo ?? { ok: false, error: 'invalid_auth' });
    }
    return realFetch(url, init);
  };
}

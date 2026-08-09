import * as path from 'node:path';

export const SLACK_FETCH_STUB_ENV_VAR = 'INVOKER_TEST_SLACK_FETCH_STUB';

export const SLACK_FETCH_STUB_PRELOAD_PATH = path.resolve(__dirname, 'slack-fetch-stub-preload.cjs');

/** Mirrors REQUIRED_BOT_SCOPES in packages/cli/src/onboarding.ts (not importable: the CLI package has no library entry point). */
const REQUIRED_BOT_SCOPES = [
  'app_mentions:read',
  'chat:write',
  'files:write',
  'pins:write',
  'channels:history',
  'channels:read',
  'groups:write',
  'groups:history',
  'users:read',
];

export function slackFetchStubSuccessJson(): string {
  return JSON.stringify({
    authTest: { ok: true, user: 'invoker-bot', team: 'Invoker E2E', scopes: REQUIRED_BOT_SCOPES.join(',') },
    connectionsOpen: { ok: true },
    conversationsInfo: { ok: true, channel: { name: 'lobby' } },
  });
}

export function slackFetchStubBadTokenJson(): string {
  return JSON.stringify({
    authTest: { ok: false, error: 'invalid_auth' },
    connectionsOpen: { ok: false, error: 'invalid_auth' },
    conversationsInfo: { ok: false, error: 'invalid_auth' },
  });
}

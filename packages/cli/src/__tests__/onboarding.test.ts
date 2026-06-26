import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  buildDoctorChecks,
  generateSlackManifest,
  loadInvokerEnv,
  REQUIRED_BOT_SCOPES,
  slackCredsFromEnv,
  upsertEnvLines,
  validateSlackCredentials,
  type CliConfigState,
} from '../onboarding.js';

describe('generateSlackManifest', () => {
  it('requests the required bot scopes, socket mode, and app_mention events', () => {
    const m = generateSlackManifest();
    expect(m.oauth_config.scopes.bot).toEqual([...REQUIRED_BOT_SCOPES]);
    expect(m.settings.socket_mode_enabled).toBe(true);
    expect(m.settings.event_subscriptions.bot_events).toContain('app_mention');
    expect(m.features.bot_user.display_name).toBe('Invoker');
  });
});

function mockFetch(routes: Record<string, { body: unknown; scopes?: string }>) {
  return async (url: string) => {
    const key = Object.keys(routes).find((k) => url.includes(k));
    const route = key ? routes[key] : { body: { ok: false, error: 'unmocked' }, scopes: undefined };
    return {
      json: async () => route.body,
      headers: { get: (h: string) => (h === 'x-oauth-scopes' ? route.scopes ?? '' : null) },
    };
  };
}

describe('validateSlackCredentials', () => {
  const creds = { botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 's', channelId: 'C123' };

  it('passes when tokens, scopes, and channel all resolve', async () => {
    const fetchImpl = mockFetch({
      'auth.test': { body: { ok: true, user: 'invoker', team: 'Acme' }, scopes: REQUIRED_BOT_SCOPES.join(',') },
      'apps.connections.open': { body: { ok: true } },
      'conversations.info': { body: { ok: true, channel: { name: 'lobby' } } },
    });
    const checks = await validateSlackCredentials(creds, fetchImpl as never);
    expect(checks.every((c) => c.status === 'ok')).toBe(true);
  });

  it('flags a missing bot scope with a reinstall remediation', async () => {
    const partial = REQUIRED_BOT_SCOPES.filter((s) => s !== 'users:read').join(',');
    const fetchImpl = mockFetch({
      'auth.test': { body: { ok: true, user: 'invoker', team: 'Acme' }, scopes: partial },
      'apps.connections.open': { body: { ok: true } },
      'conversations.info': { body: { ok: true, channel: { name: 'lobby' } } },
    });
    const checks = await validateSlackCredentials(creds, fetchImpl as never);
    const scopeCheck = checks.find((c) => c.id === 'slack-scopes');
    expect(scopeCheck?.status).toBe('error');
    expect(scopeCheck?.detail).toContain('users:read');
    expect(scopeCheck?.remediation).toContain('Reinstall');
  });

  it('errors on invalid bot and app tokens', async () => {
    const fetchImpl = mockFetch({
      'auth.test': { body: { ok: false, error: 'invalid_auth' } },
      'apps.connections.open': { body: { ok: false, error: 'invalid_auth' } },
    });
    const checks = await validateSlackCredentials(creds, fetchImpl as never);
    expect(checks.find((c) => c.id === 'slack-bot-token')?.status).toBe('error');
    expect(checks.find((c) => c.id === 'slack-app-token')?.status).toBe('error');
  });
});

describe('upsertEnvLines', () => {
  it('overwrites existing keys and preserves unrelated lines', () => {
    const out = upsertEnvLines('FOO=bar\nSLACK_BOT_TOKEN=old\n', { SLACK_BOT_TOKEN: 'new', SLACK_CHANNEL_ID: 'C9' });
    expect(out).toContain('FOO=bar');
    expect(out).toContain('SLACK_BOT_TOKEN=new');
    expect(out).not.toContain('SLACK_BOT_TOKEN=old');
    expect(out).toContain('SLACK_CHANNEL_ID=C9');
  });
});

describe('buildDoctorChecks', () => {
  const cfg: CliConfigState = {
    path: '/x/config.json',
    exists: true,
    presets: { omp: { tool: 'omp' }, 'cursor+claude': { tool: 'cursor', model: 'claude' } },
    defaultPreset: 'cursor+claude',
  };

  it('fails the default-preset check when its tool is not on PATH', () => {
    const checks = buildDoctorChecks(cfg, (cmd) => cmd === 'omp' || cmd === 'git' || cmd === 'pnpm');
    const def = checks.find((c) => c.id === 'default-preset');
    expect(def?.status).toBe('error');
    expect(def?.detail).toContain('cursor');
  });

  it('passes the default-preset check when its tool is installed', () => {
    const checks = buildDoctorChecks({ ...cfg, defaultPreset: 'omp' }, (cmd) => cmd === 'omp');
    expect(checks.find((c) => c.id === 'default-preset')?.status).toBe('ok');
  });
});

describe('loadInvokerEnv', () => {
  it('loads SLACK_* from ~/.invoker/.env without overriding real env vars', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-env-'));
    const saved = {
      HOME: process.env.HOME,
      bot: process.env.SLACK_BOT_TOKEN,
      app: process.env.SLACK_APP_TOKEN,
      sign: process.env.SLACK_SIGNING_SECRET,
      chan: process.env.SLACK_CHANNEL_ID,
    };
    try {
      process.env.HOME = home;
      mkdirSync(join(home, '.invoker'), { recursive: true });
      writeFileSync(
        join(home, '.invoker', '.env'),
        '# slack creds\nSLACK_BOT_TOKEN=xoxb-fromfile\nSLACK_APP_TOKEN=xapp-fromfile\nSLACK_CHANNEL_ID=C123\n',
      );
      delete process.env.SLACK_BOT_TOKEN;
      delete process.env.SLACK_APP_TOKEN;
      delete process.env.SLACK_CHANNEL_ID;
      process.env.SLACK_SIGNING_SECRET = 'real-env-wins';

      loadInvokerEnv();

      const creds = slackCredsFromEnv();
      expect(creds.botToken).toBe('xoxb-fromfile');
      expect(creds.appToken).toBe('xapp-fromfile');
      expect(creds.channelId).toBe('C123');
      expect(creds.signingSecret).toBe('real-env-wins');
    } finally {
      restoreEnv('HOME', saved.HOME);
      restoreEnv('SLACK_BOT_TOKEN', saved.bot);
      restoreEnv('SLACK_APP_TOKEN', saved.app);
      restoreEnv('SLACK_SIGNING_SECRET', saved.sign);
      restoreEnv('SLACK_CHANNEL_ID', saved.chan);
      rmSync(home, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

import { describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_DRAFTER_MCP_PACKAGE_SPEC, EXTERNAL_DEPENDENCIES } from '@invoker/contracts';

import {
  defaultExperimentalPlannerMcpPath,
  ensureExperimentalPlannerMcp,
  buildDoctorChecks,
  generateSlackManifest,
  installExperimentalPlannerMcp,
  loadInvokerEnv,
  readExperimentalPlannerSetup,
  REQUIRED_BOT_SCOPES,
  slackCredsFromEnv,
  runSetup,
  setExperimentalPlannerFlag,
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
    expect(m.settings.interactivity.is_enabled).toBe(true);
    expect(m.features.slash_commands?.some((c) => c.command === '/invoker')).toBe(true);
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

  it('errors on lobby conversations.info missing_scope with a reinstall remediation', async () => {
    const fetchImpl = mockFetch({
      'auth.test': { body: { ok: true, user: 'invoker', team: 'Acme' }, scopes: REQUIRED_BOT_SCOPES.join(',') },
      'apps.connections.open': { body: { ok: true } },
      'conversations.info': { body: { ok: false, error: 'missing_scope', needed: 'channels:read' } },
    });
    const checks = await validateSlackCredentials(creds, fetchImpl as never);
    const channelCheck = checks.find((c) => c.id === 'slack-channel');
    expect(channelCheck?.status).toBe('error');
    expect(channelCheck?.detail).toContain('channels:read');
    expect(channelCheck?.remediation).toContain('Reinstall');
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
describe('runSetup', () => {
  it('installs the public planner MCP by default without enabling planner behavior', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-home-'));
    const saved = {
      HOME: process.env.HOME,
      target: process.env.INVOKER_MCP_CONFIG_PATH,
    };
    const lines: string[] = [];
    try {
      process.env.HOME = home;
      delete process.env.INVOKER_MCP_CONFIG_PATH;

      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      });

      const mcpPath = join(home, '.invoker', 'mcp.json');
      const invokerConfigPath = join(home, '.invoker', 'config.json');
      expect(lines.join('\n')).toContain('Invoker setup');
      expect(lines.join('\n')).toContain(`Experimental planner MCP installed into ${mcpPath}`);
      expect(lines.join('\n')).toContain('experimentalPlanner flag: off');
      expect(lines.join('\n')).toContain('Run `invoker-cli setup slack` later');
      expect(JSON.parse(readFileSync(mcpPath, 'utf8')).mcpServers['experimental-planner']).toEqual({
        type: 'stdio',
        command: 'uvx',
        args: ['--from', DEFAULT_DRAFTER_MCP_PACKAGE_SPEC, EXTERNAL_DEPENDENCIES.drafterMcp.commandName],
      });
      expect(existsSync(invokerConfigPath)).toBe(false);
      expect(typeof code).toBe('number');
    } finally {
      restoreEnv('HOME', saved.HOME);
      restoreEnv('INVOKER_MCP_CONFIG_PATH', saved.target);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes Slack env from environment values without prompts', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-env-'));
    const saved = {
      HOME: process.env.HOME,
      bot: process.env.SLACK_BOT_TOKEN,
      app: process.env.SLACK_APP_TOKEN,
      sign: process.env.SLACK_SIGNING_SECRET,
      chan: process.env.SLACK_CHANNEL_ID,
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(mockFetch({
      'auth.test': { body: { ok: true, user: 'invoker', team: 'Acme' }, scopes: REQUIRED_BOT_SCOPES.join(',') },
      'apps.connections.open': { body: { ok: true } },
      'conversations.info': { body: { ok: true, channel: { name: 'lobby' } } },
    }) as never);
    try {
      process.env.HOME = home;
      process.env.SLACK_BOT_TOKEN = 'xoxb-env';
      process.env.SLACK_APP_TOKEN = 'xapp-env';
      process.env.SLACK_SIGNING_SECRET = 'secret-env';
      process.env.SLACK_CHANNEL_ID = 'C123';
      const prompts: string[] = [];

      const code = await runSetup(['slack', '--from-env'], {
        print: () => {},
        prompt: async (question) => {
          prompts.push(question);
          return '';
        },
      });

      expect(code).toBe(0);
      expect(prompts).toEqual([]);
    } finally {
      fetchSpy.mockRestore();
      restoreEnv('HOME', saved.HOME);
      restoreEnv('SLACK_BOT_TOKEN', saved.bot);
      restoreEnv('SLACK_APP_TOKEN', saved.app);
      restoreEnv('SLACK_SIGNING_SECRET', saved.sign);
      restoreEnv('SLACK_CHANNEL_ID', saved.chan);
      rmSync(home, { recursive: true, force: true });
    }
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

describe('experimental planner MCP setup', () => {
  it('installs the redirect server and enables the Invoker flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-planner-setup-'));
    const targetPath = join(dir, 'mcp.json');
    const configPath = join(dir, 'config.json');
    try {
      writeFileSync(targetPath, JSON.stringify({ mcpServers: { invoker: { type: 'stdio', command: 'invoker-cli', args: ['mcp'] } } }));
      writeFileSync(configPath, JSON.stringify({ defaultSlackHarnessPreset: 'omp' }));

      const state = installExperimentalPlannerMcp({
        targetPath,
        configPath,
        plannerUrl: 'http://planner.test',
        accessToken: 'sek',
      });

      expect(state).toEqual({ targetPath, configPath, installed: true, experimentalPlanner: true });
      const mcpConfig = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(mcpConfig.mcpServers.invoker).toEqual({ type: 'stdio', command: 'invoker-cli', args: ['mcp'] });
      expect(mcpConfig.mcpServers['experimental-planner']).toEqual({
        type: 'stdio',
        command: 'uvx',
        args: ['--from', DEFAULT_DRAFTER_MCP_PACKAGE_SPEC, EXTERNAL_DEPENDENCIES.drafterMcp.commandName],
        env: { PLANNER_URL: 'http://planner.test', PLANNER_ACCESS_TOKEN: 'sek' },
      });
      expect(JSON.parse(readFileSync(configPath, 'utf8')).experimentalPlanner).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  it('can pin a different planner package without changing Invoker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-planner-setup-'));
    const targetPath = join(dir, 'mcp.json');
    const configPath = join(dir, 'config.json');
    try {
      installExperimentalPlannerMcp({
        targetPath,
        configPath,
        plannerPackage: `${EXTERNAL_DEPENDENCIES.drafterMcp.packageName}==0.1.1`,
      });

      const mcpConfig = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(mcpConfig.mcpServers['experimental-planner'].args).toEqual([
        '--from',
        `${EXTERNAL_DEPENDENCIES.drafterMcp.packageName}==0.1.1`,
        EXTERNAL_DEPENDENCIES.drafterMcp.commandName,
      ]);
      expect(readExperimentalPlannerSetup({ targetPath, configPath }).installed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses a packaged Invoker MCP config path when no target is passed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-planner-setup-'));
    const configPath = join(dir, 'config.json');
    const targetPath = join(dir, 'mcp.json');
    const savedTarget = process.env.INVOKER_MCP_CONFIG_PATH;
    try {
      delete process.env.INVOKER_MCP_CONFIG_PATH;

      const state = ensureExperimentalPlannerMcp({ configPath });

      expect(defaultExperimentalPlannerMcpPath(configPath)).toBe(targetPath);
      expect(state).toEqual({ targetPath, configPath, installed: true, experimentalPlanner: false });
      const mcpConfig = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(mcpConfig.mcpServers['experimental-planner'].args).toEqual([
        '--from',
        DEFAULT_DRAFTER_MCP_PACKAGE_SPEC,
        EXTERNAL_DEPENDENCIES.drafterMcp.commandName,
      ]);
      expect(existsSync(configPath)).toBe(false);
    } finally {
      restoreEnv('INVOKER_MCP_CONFIG_PATH', savedTarget);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('logs malformed MCP config parse failures before throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-planner-setup-'));
    const targetPath = join(dir, 'mcp.json');
    const configPath = join(dir, 'config.json');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      writeFileSync(targetPath, '{broken', 'utf8');

      expect(() => installExperimentalPlannerMcp({ targetPath, configPath })).toThrow('Invalid JSON object');
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(`Failed to parse JSON object at ${targetPath}`));
    } finally {
      stderrSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uninstalls the redirect server and disables the Invoker flag', () => {
    const dir = mkdtempSync(join(tmpdir(), 'invoker-planner-setup-'));
    const targetPath = join(dir, 'mcp.json');
    const configPath = join(dir, 'config.json');
    try {
      installExperimentalPlannerMcp({ targetPath, configPath });

      const state = installExperimentalPlannerMcp({ targetPath, configPath, uninstall: true });

      expect(state).toEqual({ targetPath, configPath, installed: false, experimentalPlanner: false });
      const mcpConfig = JSON.parse(readFileSync(targetPath, 'utf8'));
      expect(mcpConfig.mcpServers['experimental-planner']).toBeUndefined();
      expect(readExperimentalPlannerSetup({ targetPath, configPath }).installed).toBe(false);
      expect(JSON.parse(readFileSync(configPath, 'utf8')).experimentalPlanner).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe('setExperimentalPlannerFlag', () => {
  function makeConfigPath(): string {
    return join(mkdtempSync(join(tmpdir(), 'invoker-planner-flag-')), 'config.json');
  }

  it('preserves unrelated config keys when toggling the flag', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ maxConcurrency: 9, futureKey: { nested: true } }));

    setExperimentalPlannerFlag(true, configPath);

    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({
      maxConcurrency: 9,
      futureKey: { nested: true },
      experimentalPlanner: true,
    });
  });

  it('writes the config with owner-only permissions', () => {
    const configPath = makeConfigPath();
    setExperimentalPlannerFlag(true, configPath);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('tightens permissions on a previously world-readable config', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ webToken: 'secret' }));
    chmodSync(configPath, 0o644);

    setExperimentalPlannerFlag(false, configPath);

    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it('backs up the previous config before overwriting it', () => {
    const configPath = makeConfigPath();
    writeFileSync(configPath, JSON.stringify({ experimentalPlanner: false }));

    setExperimentalPlannerFlag(true, configPath);

    expect(JSON.parse(readFileSync(`${configPath}.bak`, 'utf8'))).toEqual({ experimentalPlanner: false });
  });

  it('creates the config directory when it does not exist', () => {
    const configPath = join(mkdtempSync(join(tmpdir(), 'invoker-planner-flag-')), 'nested', 'config.json');
    setExperimentalPlannerFlag(true, configPath);
    expect(JSON.parse(readFileSync(configPath, 'utf8'))).toEqual({ experimentalPlanner: true });
  });
});

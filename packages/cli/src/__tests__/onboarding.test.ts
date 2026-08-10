import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_DRAFTER_MCP_PACKAGE_SPEC, EXTERNAL_DEPENDENCIES } from '@invoker/contracts';

import {
  assertNoConfigWriteOnAllDeclined,
  assertNoSecretPrinted,
  assertOptionalToolPromptedBeforeInstall,
  assertRemoteTargetOnlyPersistedAfterAllChecksPass,
} from '../onboarding-invariants.js';

import {
  checkGithubAuth,
  defaultExperimentalPlannerMcpPath,
  ensureExperimentalPlannerMcp,
  buildDoctorChecks,
  firstSetupFailure,
  formatSetupEnding,
  generateSlackManifest,
  installExperimentalPlannerMcp,
  loadInvokerEnv,
  readExperimentalPlannerSetup,
  REQUIRED_BOT_SCOPES,
  runPlanValidationSmoke,
  slackCredsFromEnv,
  runSetup,
  setExperimentalPlannerFlag,
  upsertEnvLines,
  validateSlackCredentials,
  type CliConfigState,
  type SetupDeps,
} from '../onboarding.js';

import type { PrerequisiteCheck } from '@invoker/contracts';

type Check = PrerequisiteCheck;

function okCheck(id: string, name: string, detail = 'ok'): Check {
  return { id, name, status: 'ok', detail };
}

function errorCheck(id: string, name: string, detail: string, remediation?: string): Check {
  return { id, name, status: 'error', detail, remediation };
}

/** Keep setup oneshot tests offline and independent of the host PATH / gh login. */
const NOOP_BUNDLED_SKILLS_STATUS = {
  available: false,
  promptRecommended: false,
  managedPrefix: 'invoker-',
  bundledSkillNames: [],
  targets: [],
  commandTargets: [],
  mcpTargets: [],
};

function readySetupDeps(overrides: SetupDeps = {}): SetupDeps {
  return {
    isInstalled: () => true,
    githubAuthCheck: async () => okCheck('github-auth', 'GitHub auth', 'gh is authenticated'),
    smokePlanValidation: async () => okCheck('smoke-plan', 'smoke: plan validation', 'Parsed 1 task(s)'),
    // Real skill install does real commandExists probing + filesystem work —
    // stub it by default so unrelated tests stay fast and deterministic.
    resolveSkillsRepoRoot: () => '/fake-repo-root',
    resolveStandaloneSkillsRoot: () => null,
    bundledSkillsInstall: () => NOOP_BUNDLED_SKILLS_STATUS,
    ...overrides,
  };
}

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
  it('does not install the Drafter planner MCP by default', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-home-'));
    const saved = {
      HOME: process.env.HOME,
      target: process.env.INVOKER_MCP_CONFIG_PATH,
    };
    const lines: string[] = [];
    try {
      process.env.HOME = home;
      delete process.env.INVOKER_MCP_CONFIG_PATH;

      const answers = ['n', 'n', 'n', 'n', 'n', 'y'];
      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => answers.shift() ?? 'n',
      }, readySetupDeps());

      const mcpPath = join(home, '.invoker', 'mcp.json');
      const invokerConfigPath = join(home, '.invoker', 'config.json');
      const output = lines.join('\n');
      expect(output).toContain('Invoker setup');
      expect(output).not.toContain('planner');
      expect(output).toContain("You're ready.");
      expect(existsSync(mcpPath)).toBe(false);
      expect(existsSync(invokerConfigPath)).toBe(false);
      expect(code).toBe(0);

      expect(() => assertOptionalToolPromptedBeforeInstall(lines, 'Drafter')).not.toThrow();
      const writtenPaths = [mcpPath, invokerConfigPath].filter((path) => existsSync(path));
      expect(() => assertNoConfigWriteOnAllDeclined(writtenPaths, true)).not.toThrow();
    } finally {
      restoreEnv('HOME', saved.HOME);
      restoreEnv('INVOKER_MCP_CONFIG_PATH', saved.target);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('installs bundled skills as part of setup and reports the result', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-skills-'));
    const saved = { HOME: process.env.HOME };
    const lines: string[] = [];
    const fakeStatus = {
      available: true,
      promptRecommended: false,
      managedPrefix: 'invoker-',
      bundledSkillNames: ['plan-to-invoker', 'make-pr'],
      targets: [{ id: 'claude', name: 'Claude', path: '/x', available: true, installed: true, upToDate: true, installedSkillNames: [] }],
      commandTargets: [],
      mcpTargets: [{ id: 'claude', name: 'Claude', path: '/x/.claude.json', available: true, installed: true, upToDate: true, serverName: 'invoker' }],
    };
    try {
      process.env.HOME = home;

      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      }, readySetupDeps({
        resolveSkillsRepoRoot: () => '/fake/repo',
        bundledSkillsInstall: () => fakeStatus,
      }));

      expect(code).toBe(0);
      const output = lines.join('\n');
      expect(output).toContain('Skills: installed 2 bundled skill(s) for Claude.');
      expect(output).toContain('Skills MCP: registered invoker-cli mcp for Claude.');
    } finally {
      restoreEnv('HOME', saved.HOME);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('falls back to skills bundled next to the running binary when not in a checkout', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-skills-standalone-'));
    const saved = { HOME: process.env.HOME };
    const lines: string[] = [];
    const fakeStatus = {
      available: true,
      promptRecommended: false,
      managedPrefix: 'invoker-',
      bundledSkillNames: ['plan-to-invoker'],
      targets: [{ id: 'claude', name: 'Claude', path: '/x', available: true, installed: true, upToDate: true, installedSkillNames: [] }],
      commandTargets: [],
      mcpTargets: [{ id: 'claude', name: 'Claude', path: '/x/.claude.json', available: true, installed: true, upToDate: true, serverName: 'invoker' }],
    };
    try {
      process.env.HOME = home;

      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      }, readySetupDeps({
        resolveSkillsRepoRoot: () => { throw new Error('Could not resolve repo root'); },
        resolveStandaloneSkillsRoot: () => '/fake/vendor',
        bundledSkillsInstall: () => fakeStatus,
      }));

      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('Skills: installed 1 bundled skill(s) for Claude.');
    } finally {
      restoreEnv('HOME', saved.HOME);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips skill installation gracefully when not running from an Invoker checkout and no bundled skills are found', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-skills-none-'));
    const saved = { HOME: process.env.HOME };
    const lines: string[] = [];
    try {
      process.env.HOME = home;

      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      }, readySetupDeps({
        resolveSkillsRepoRoot: () => { throw new Error('Could not resolve repo root'); },
        resolveStandaloneSkillsRoot: () => null,
      }));

      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('Skills: skipped (not running from an Invoker checkout, and no bundled skills next to this binary).');
    } finally {
      restoreEnv('HOME', saved.HOME);
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('writes only the worker toggle the user says yes to, leaving the rest unset', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-toggles-'));
    const saved = { HOME: process.env.HOME };
    const lines: string[] = [];
    try {
      process.env.HOME = home;

      // Prompt order: Slack, machines, then the 4 worker toggles in
      // ONBOARDING_WORKER_TOGGLES order (PR maintenance, e2e auto-fix,
      // auto-approve, disk-headroom cleanup).
      const answers = ['n', 'n', 'n', 'y', 'n', 'y'];
      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => answers.shift() ?? 'n',
      }, readySetupDeps());

      expect(code).toBe(0);
      const configPath = join(home, '.invoker', 'config.json');
      const config = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(config).toEqual({ e2eAutoFixEnabled: true });
      expect(lines.join('\n')).toContain('Worker toggles');
    } finally {
      restoreEnv('HOME', saved.HOME);
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
      const lines: string[] = [];

      const code = await runSetup(['slack', '--from-env'], {
        print: (line) => lines.push(line),
        prompt: async (question) => {
          prompts.push(question);
          return '';
        },
      }, readySetupDeps());

      expect(code).toBe(0);
      expect(prompts).toEqual([]);
      expect(() => assertNoSecretPrinted(lines, ['xoxb-env', 'xapp-env', 'secret-env'])).not.toThrow();
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

  function setupMachineTestEnv() {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-machines-'));
    const saved = {
      config: process.env.INVOKER_REPO_CONFIG_PATH,
      mcp: process.env.INVOKER_MCP_CONFIG_PATH,
    };
    process.env.INVOKER_REPO_CONFIG_PATH = join(home, 'config.json');
    process.env.INVOKER_MCP_CONFIG_PATH = join(home, 'mcp.json');
    return {
      home,
      configPath: process.env.INVOKER_REPO_CONFIG_PATH,
      restore: () => {
        restoreEnv('INVOKER_REPO_CONFIG_PATH', saved.config);
        restoreEnv('INVOKER_MCP_CONFIG_PATH', saved.mcp);
        rmSync(home, { recursive: true, force: true });
      },
    };
  }

  function passingDoctorChecks(): PrerequisiteCheck[] {
    return [
      { id: 'git', name: 'Git (remote)', status: 'ok', detail: 'git found on remote box' },
      { id: 'node', name: 'Node (remote)', status: 'ok', detail: 'node found on remote box' },
      { id: 'pnpm', name: 'pnpm (remote)', status: 'ok', detail: 'pnpm found on remote box' },
      { id: 'disk-space', name: 'Disk space (remote)', status: 'ok', detail: '10240 MiB free on the remote box' },
      { id: 'push-auth', name: 'GitHub push credentials (remote)', status: 'ok', detail: 'reachable' },
    ];
  }

  function machineSetupDeps(overrides: SetupDeps = {}): SetupDeps {
    return readySetupDeps({
      remoteTargetConnectivity: async (target) => ({
        reachable: true,
        message: `ssh probe to ${target.user}@${target.host} succeeded`,
      }),
      remoteDoctorChecks: async () => passingDoctorChecks(),
      ...overrides,
    });
  }

  it('adds one machine through the interactive setup path', async () => {
    const env = setupMachineTestEnv();
    const prompts: string[] = [];
    const answers = [
      'build-a',
      'build-a.example.test',
      'deploy',
      '/home/deploy/.ssh/id_ed25519',
      'https://github.com/example/build-a.git',
      '2222',
      '3',
      'pnpm install --frozen-lockfile',
      'y',
      'n',
    ];
    try {
      const code = await runSetup(['machines'], {
        print: () => {},
        prompt: async (question) => {
          prompts.push(question);
          return answers.shift() ?? '';
        },
      }, machineSetupDeps());

      expect(code).toBe(0);
      expect(prompts).toContain('Machine name: ');
      expect(JSON.parse(readFileSync(env.configPath, 'utf8')).remoteTargets).toEqual({
        'build-a': {
          host: 'build-a.example.test',
          user: 'deploy',
          sshKeyPath: '/home/deploy/.ssh/id_ed25519',
          port: 2222,
          maxConcurrentTasks: 3,
          provisionCommand: 'pnpm install --frozen-lockfile',
        },
      });

      expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(passingDoctorChecks(), true)).not.toThrow();
    } finally {
      env.restore();
    }
  });

  it('leaves config unchanged when the user declines to keep a passing machine', async () => {
    const env = setupMachineTestEnv();
    const originalConfig = { maxConcurrency: 4 };
    writeFileSync(env.configPath, JSON.stringify(originalConfig));
    const answers = [
      'build-a',
      'build-a.example.test',
      'deploy',
      '/home/deploy/.ssh/id_ed25519',
      'https://github.com/example/build-a.git',
      '22',
      '1',
      '',
      'n',
      'n',
      'n',
    ];
    try {
      const code = await runSetup(['machines'], {
        print: () => {},
        prompt: async () => answers.shift() ?? '',
      }, machineSetupDeps());

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(env.configPath, 'utf8'))).toEqual(originalConfig);
    } finally {
      env.restore();
    }
  });

  it('loops to add another machine and writes both entries', async () => {
    const env = setupMachineTestEnv();
    const answers = [
      'build-a',
      'build-a.example.test',
      'deploy',
      '/home/deploy/.ssh/id_a',
      'https://github.com/example/build-a.git',
      '22',
      '2',
      '',
      'y',
      'y',
      'build-b',
      'build-b.example.test',
      'deploy',
      '/home/deploy/.ssh/id_b',
      'https://github.com/example/build-b.git',
      '2223',
      '4',
      'bash scripts/provision.sh',
      'y',
      'n',
    ];
    try {
      const code = await runSetup(['machines'], {
        print: () => {},
        prompt: async () => answers.shift() ?? '',
      }, machineSetupDeps());

      expect(code).toBe(0);
      expect(JSON.parse(readFileSync(env.configPath, 'utf8')).remoteTargets).toEqual({
        'build-a': {
          host: 'build-a.example.test',
          user: 'deploy',
          sshKeyPath: '/home/deploy/.ssh/id_a',
          port: 22,
          maxConcurrentTasks: 2,
        },
        'build-b': {
          host: 'build-b.example.test',
          user: 'deploy',
          sshKeyPath: '/home/deploy/.ssh/id_b',
          port: 2223,
          maxConcurrentTasks: 4,
          provisionCommand: 'bash scripts/provision.sh',
        },
      });
    } finally {
      env.restore();
    }
  });

  it('reads machines from stdin and prints one JSON result per input machine under --json', async () => {
    const env = setupMachineTestEnv();
    const lines: string[] = [];
    const input = [
      {
        name: 'build-a',
        host: 'build-a.example.test',
        user: 'deploy',
        sshKeyPath: '/home/deploy/.ssh/id_a',
        repoUrl: 'https://github.com/example/build-a.git',
        port: 22,
        maxConcurrentTasks: 2,
      },
      {
        name: 'build-b',
        host: 'build-b.example.test',
        user: 'ci',
        sshKeyPath: '/home/ci/.ssh/id_b',
        repoUrl: 'https://github.com/example/build-b.git',
        port: 2222,
        maxConcurrentTasks: 1,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    ];
    try {
      const code = await runSetup(['machines', '--json'], {
        print: (line) => lines.push(line),
        prompt: async () => { throw new Error('should not prompt in json mode'); },
        readStdin: async () => JSON.stringify(input),
        interactive: false,
      }, machineSetupDeps());

      expect(code).toBe(0);
      expect(lines).toHaveLength(1);
      const results = JSON.parse(lines[0]);
      expect(results).toHaveLength(input.length);
      expect(results.map((result: { name: string; written: boolean }) => [result.name, result.written])).toEqual([
        ['build-a', true],
        ['build-b', true],
      ]);
      expect(Object.keys(JSON.parse(readFileSync(env.configPath, 'utf8')).remoteTargets)).toEqual(['build-a', 'build-b']);
    } finally {
      env.restore();
    }
  });

  it('never writes a machine whose remote doctor checks fail, even though connectivity passed', async () => {
    const env = setupMachineTestEnv();
    const originalConfig = { maxConcurrency: 4 };
    writeFileSync(env.configPath, JSON.stringify(originalConfig));
    const answers = [
      'build-a',
      'build-a.example.test',
      'deploy',
      '/home/deploy/.ssh/id_ed25519',
      'https://github.com/example/build-a.git',
      '22',
      '1',
      '',
      'n', // "Try this machine again?" — no
    ];
    const lines: string[] = [];
    const doctorChecks = [
      { id: 'git', name: 'Git (remote)', status: 'ok' as const, detail: 'git found on remote box' },
      {
        id: 'push-auth',
        name: 'GitHub push credentials (remote)',
        status: 'error' as const,
        detail: 'Remote box could not reach https://github.com/example/build-a.git with its own git credentials',
      },
    ];
    try {
      const code = await runSetup(['machines'], {
        print: (line) => lines.push(line),
        prompt: async () => answers.shift() ?? '',
      }, machineSetupDeps({
        remoteDoctorChecks: async () => doctorChecks,
      }));

      const finalConfig = JSON.parse(readFileSync(env.configPath, 'utf8'));
      expect(code).toBe(0);
      expect(finalConfig).toEqual(originalConfig);
      expect(lines.join('\n')).toContain('Remote readiness check failed');
      expect(lines.join('\n')).not.toContain('Keep this machine?');

      const wasWritten = Boolean(finalConfig.remoteTargets?.['build-a']);
      expect(() => assertRemoteTargetOnlyPersistedAfterAllChecksPass(doctorChecks, wasWritten)).not.toThrow();
    } finally {
      env.restore();
    }
  });

  it('surfaces a doctor-check failure as an error result under --json without writing the machine', async () => {
    const env = setupMachineTestEnv();
    const input = [{
      name: 'build-a',
      host: 'build-a.example.test',
      user: 'deploy',
      sshKeyPath: '/home/deploy/.ssh/id_a',
      repoUrl: 'https://github.com/example/build-a.git',
    }];
    const lines: string[] = [];
    try {
      const code = await runSetup(['machines', '--json'], {
        print: (line) => lines.push(line),
        prompt: async () => { throw new Error('should not prompt in json mode'); },
        readStdin: async () => JSON.stringify(input),
        interactive: false,
      }, machineSetupDeps({
        remoteDoctorChecks: async () => [
          {
            id: 'disk-space',
            name: 'Disk space (remote)',
            status: 'error',
            detail: 'out of disk space',
          },
        ],
      }));

      expect(code).toBe(1);
      const results = JSON.parse(lines[0]);
      expect(results[0].written).toBe(false);
      expect(results[0].error.code).toBe('doctor-check-failed');
      expect(existsSync(env.configPath)).toBe(false);
    } finally {
      env.restore();
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

describe('runSetup in a non-interactive shell', () => {
  let home: string;
  let previousConfig: string | undefined;
  let previousMcp: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'invoker-setup-tty-'));
    previousConfig = process.env.INVOKER_REPO_CONFIG_PATH;
    previousMcp = process.env.INVOKER_MCP_CONFIG_PATH;
    process.env.INVOKER_REPO_CONFIG_PATH = join(home, 'config.json');
    process.env.INVOKER_MCP_CONFIG_PATH = join(home, 'mcp.json');
  });

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
    else process.env.INVOKER_REPO_CONFIG_PATH = previousConfig;
    if (previousMcp === undefined) delete process.env.INVOKER_MCP_CONFIG_PATH;
    else process.env.INVOKER_MCP_CONFIG_PATH = previousMcp;
    rmSync(home, { recursive: true, force: true });
  });

  function collectingIO(overrides: Partial<{ prompt: () => Promise<string> }> = {}) {
    const lines: string[] = [];
    return {
      lines,
      io: {
        interactive: false,
        print: (line: string) => { lines.push(line); },
        prompt: overrides.prompt ?? (async () => ''),
      },
    };
  }

  it('fails loudly instead of silently answering no to every prompt', async () => {
    const { lines, io } = collectingIO();
    const code = await runSetup([], io, readySetupDeps());

    expect(code).toBe(1);
    expect(lines.join('\n')).toContain('stdin is not a TTY');
  });

  it('names the non-interactive escape hatches in the failure message', async () => {
    const { lines, io } = collectingIO();
    await runSetup([], io, readySetupDeps());

    const output = lines.join('\n');
    expect(output).toContain('--yes');
    expect(output).toContain('--from-env');
  });

  it('does not prompt about the planner under --yes', async () => {
    const { lines, io } = collectingIO({
      prompt: async () => { throw new Error('should not prompt under --yes'); },
    });

    const code = await runSetup(['--yes'], io, readySetupDeps());

    expect(code).toBe(0);
    expect(lines.join('\n')).not.toContain('planner');
    expect(lines.join('\n')).toContain("You're ready.");
  });

  it('leaves every worker toggle unset under --yes without prompting', async () => {
    const { lines, io } = collectingIO({
      prompt: async () => { throw new Error('should not prompt under --yes'); },
    });

    const code = await runSetup(['--yes'], io, readySetupDeps());

    expect(code).toBe(0);
    expect(lines.join('\n')).toContain('Worker toggles');
    expect(lines.join('\n')).toContain('PR maintenance: off');
  });

  it('skips Slack under --yes rather than starting a flow it cannot finish', async () => {
    const { lines, io } = collectingIO({
      prompt: async () => { throw new Error('should not prompt under --yes'); },
    });

    await runSetup(['--yes'], io, readySetupDeps());

    const output = lines.join('\n');
    expect(output).not.toContain('Bot User OAuth Token');
    expect(output).toContain("You're ready.");
  });

  it('writes nothing under --yes since planner, Slack, and machines all stay opt-in', async () => {
    const { io } = collectingIO({
      prompt: async () => { throw new Error('should not prompt under --yes'); },
    });

    await runSetup(['--yes'], io, readySetupDeps());

    expect(existsSync(join(home, 'mcp.json'))).toBe(false);
  });
});

describe('GitHub auth check', () => {
  it('passes when gh auth status exits 0', () => {
    const check = checkGithubAuth(() => ({ status: 0, stdout: 'Logged in', stderr: '' }));
    expect(check).toMatchObject({ id: 'github-auth', status: 'ok' });
  });

  it('fails when gh auth status exits non-zero', () => {
    const check = checkGithubAuth(() => ({ status: 1, stdout: '', stderr: 'not logged in to any GitHub hosts' }));
    expect(check.status).toBe('error');
    expect(check.detail).toContain('not logged in');
    expect(check.remediation).toContain('gh auth login');
  });

  it('warns and skips when the injected runner cannot spawn gh', () => {
    const missing = Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' });
    const check = checkGithubAuth(() => {
      throw missing;
    });
    expect(check).toMatchObject({ id: 'github-auth', status: 'warn' });
    expect(check.remediation).toContain('gh auth login');
  });

  it('warns and skips when the injected runner reports gh is missing', () => {
    const check = checkGithubAuth(() => ({
      status: 127,
      stdout: '',
      stderr: 'sh: gh: command not found',
    }));
    expect(check).toMatchObject({ id: 'github-auth', status: 'warn' });
    expect(check.remediation).toContain('gh auth login');
  });
});

describe('setup oneshot ending', () => {
  it('selects the first error for Fix this first', () => {
    const checks: Check[] = [
      okCheck('a', 'A'),
      errorCheck('github-auth', 'GitHub auth', 'not logged in', 'Run `gh auth login`'),
      errorCheck('smoke-plan', 'smoke: plan validation', 'boom'),
    ];
    expect(firstSetupFailure(checks)?.id).toBe('github-auth');
    expect(formatSetupEnding(checks)).toContain('Fix this first: GitHub auth: not logged in.');
    expect(formatSetupEnding(checks)).toContain('gh auth login');
    expect(formatSetupEnding([okCheck('a', 'A')])).toBe("You're ready.");
  });

  it('returns exit code 1 when smoke validation fails', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-smoke-fail-'));
    const lines: string[] = [];
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      }, readySetupDeps({
        smokePlanValidation: async () => errorCheck(
          'smoke-plan',
          'smoke: plan validation',
          'parse failed',
          'Reinstall invoker-cli',
        ),
      }));

      expect(code).toBe(1);
      expect(lines.join('\n')).toContain('Fix this first: smoke: plan validation: parse failed.');
      expect(lines.join('\n')).not.toContain("You're ready.");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('skips GitHub auth with a warning when gh is not installed', async () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-setup-no-gh-'));
    const lines: string[] = [];
    const savedHome = process.env.HOME;
    try {
      process.env.HOME = home;
      const code = await runSetup([], {
        print: (line) => lines.push(line),
        prompt: async () => 'n',
      }, readySetupDeps({
        isInstalled: (command) => command !== 'gh',
        githubAuthCheck: async () => {
          throw new Error('should not probe gh auth when gh is missing');
        },
      }));

      expect(code).toBe(0);
      expect(lines.join('\n')).toContain('gh not installed; skipped auth check');
      expect(lines.join('\n')).toContain("You're ready.");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('runs the real offline smoke parser successfully', async () => {
    const check = await runPlanValidationSmoke();
    expect(check.status).toBe('ok');
    expect(check.detail).toMatch(/Parsed 1 task/);
  });
});

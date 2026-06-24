import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  checkSlackSetup,
  DEFAULT_SLACK_HARNESS_PRESETS,
  formatSlackSetupPreflight,
  loadConfig,
  resolveEmbeddedTerminalBackendConfig,
} from '../config.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `invoker-config-test-${process.pid}`);
const fakeHome = join(testDir, 'home');

beforeEach(() => {
  mkdirSync(join(fakeHome, '.invoker'), { recursive: true });
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    homedir: () => fakeHome,
  };
});

describe('loadConfig', () => {
  it('returns empty config when no files exist', () => {
    const config = loadConfig();
    expect(config).toEqual({});
  });

  it('reads user-level ~/.invoker/config.json', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig();
    expect(config.defaultBranch).toBe('main');
  });

  it('throws on malformed JSON', () => {
    writeFileSync(join(fakeHome, '.invoker', 'config.json'), 'not json {{{');
    expect(() => loadConfig()).toThrow(/Invalid Invoker config JSON/);
  });

  it('throws on non-object JSON', () => {
    writeFileSync(join(fakeHome, '.invoker', 'config.json'), '"just a string"');
    expect(() => loadConfig()).toThrow(/expected a JSON object/);
  });

  it('reads planningTimeoutSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningTimeoutSeconds: 600 }),
    );
    const config = loadConfig();
    expect(config.planningTimeoutSeconds).toBe(600);
  });

  it('reads planningHeartbeatIntervalSeconds from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ planningHeartbeatIntervalSeconds: 30 }),
    );
    const config = loadConfig();
    expect(config.planningHeartbeatIntervalSeconds).toBe(30);
  });

  it('reads disableAutoRunOnStartup from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ disableAutoRunOnStartup: true }),
    );
    const config = loadConfig();
    expect(config.disableAutoRunOnStartup).toBe(true);
  });

  it('reads maxConcurrency from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ maxConcurrency: 6 }),
    );
    const config = loadConfig();
    expect(config.maxConcurrency).toBe(6);
  });

  it('reads autoFixRetries from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ autoFixRetries: 3 }),
    );
    const config = loadConfig();
    expect(config.autoFixRetries).toBe(3);
  });

  it('reads autoApproveAIFixes from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ autoApproveAIFixes: true }),
    );
    const config = loadConfig();
    expect(config.autoApproveAIFixes).toBe(true);
  });

  it('reads autoFixAgent from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ autoFixAgent: 'codex' }),
    );
    const config = loadConfig();
    expect(config.autoFixAgent).toBe('codex');
  });

  it('reads autoFixCi from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ autoFixCi: true }),
    );
    const config = loadConfig();
    expect(config.autoFixCi).toBe(true);
  });

  it('loadConfig picks up browser field', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ browser: 'firefox' }),
    );
    const config = loadConfig();
    expect(config.browser).toBe('firefox');
  });

  it('reads imageStorage from user config', () => {
    const imageStorage = {
      provider: 'r2',
      accountId: 'abc123',
      bucketName: 'my-bucket',
      accessKeyId: 'key',
      secretAccessKey: 'secret',
      publicUrlBase: 'https://my-bucket.r2.dev',
    };
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ imageStorage }),
    );
    const config = loadConfig();
    expect(config.imageStorage).toEqual(imageStorage);
  });

  it('reads executorRoutingRules route strategy from user config', () => {
    const executorRoutingRules = [{
      regex: '\\bpnpm(?:\\s|$)',
      poolId: 'ssh-light',
      strategy: 'route',
    }];
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ executorRoutingRules }),
    );
    const config = loadConfig();
    expect(config.executorRoutingRules).toEqual(executorRoutingRules);
  });

  it('reads remote target maxConcurrentTasks from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({
        remoteTargets: {
          ci1: {
            host: '10.0.0.1',
            user: 'invoker',
            sshKeyPath: '/tmp/key',
            maxConcurrentTasks: 2,
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.remoteTargets?.ci1?.maxConcurrentTasks).toBe(2);
  });

  it('reads executionPools from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({
        executionPools: {
          'ssh-light': {
            members: [
              { type: 'ssh', id: 'remote-1' },
              { type: 'ssh', id: 'remote-2' },
              { type: 'worktree', id: 'local-fallback', maxConcurrentTasks: 2 },
            ],
            selectionStrategy: 'roundRobin',
            maxConcurrentTasksPerMember: 1,
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.executionPools?.['ssh-light']).toEqual({
      members: [
        { type: 'ssh', id: 'remote-1' },
        { type: 'ssh', id: 'remote-2' },
        { type: 'worktree', id: 'local-fallback', maxConcurrentTasks: 2 },
      ],
      selectionStrategy: 'roundRobin',
      maxConcurrentTasksPerMember: 1,
    });
  });

  it('reads defaultPoolId from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultPoolId: 'mixed-local-ssh' }),
    );
    const config = loadConfig();
    expect(config.defaultPoolId).toBe('mixed-local-ssh');
  });

});

describe('checkSlackSetup', () => {
  const slackEnv = {
    SLACK_BOT_TOKEN: 'xoxb-token',
    SLACK_APP_TOKEN: 'xapp-token',
    SLACK_SIGNING_SECRET: 'secret',
    SLACK_CHANNEL_ID: 'C123',
  };

  it('accepts the built-in Slack harness defaults when Slack env is present', () => {
    const result = checkSlackSetup({}, slackEnv);
    expect(result.missingEnv).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(result.defaultHarnessPreset).toBe('cursor+claude');
    expect(result.harnessPresets).toEqual(DEFAULT_SLACK_HARNESS_PRESETS);
  });

  it('reports all missing Slack env vars before startup', () => {
    const result = checkSlackSetup({}, { SLACK_BOT_TOKEN: 'xoxb-token' });
    expect(result.missingEnv).toEqual([
      'SLACK_APP_TOKEN',
      'SLACK_SIGNING_SECRET',
      'SLACK_CHANNEL_ID',
    ]);

    expect(formatSlackSetupPreflight(result)).toContain(
      'Missing env vars: SLACK_APP_TOKEN, SLACK_SIGNING_SECRET, SLACK_CHANNEL_ID.',
    );
  });

  it('rejects a default Slack preset missing from a custom preset override', () => {
    const result = checkSlackSetup({
      slackHarnessPresets: {
        'omp+claude': { tool: 'omp', model: 'anthropic/claude-opus-4' },
      },
      defaultSlackHarnessPreset: 'cursor+claude',
    }, slackEnv);

    expect(result.errors).toContain(
      'defaultSlackHarnessPreset "cursor+claude" is not defined in slackHarnessPresets. Configured presets: omp+claude.',
    );
  });

  it('rejects malformed Slack repo aliases with actionable errors', () => {
    const result = checkSlackSetup({
      slackRepos: {
        web: '',
      },
    }, slackEnv);

    expect(result.errors).toContain('slackRepos.web must be a non-empty git URL.');
  });
});

describe('resolveEmbeddedTerminalBackendConfig', () => {
  it('defaults GUI embedded terminals to the PTY backend', () => {
    expect(resolveEmbeddedTerminalBackendConfig({}, {})).toBe('pty');
  });

  it('reads the configured GUI embedded terminal backend', () => {
    expect(resolveEmbeddedTerminalBackendConfig({
      terminal: { embeddedBackend: 'pty' },
    }, {})).toBe('pty');
  });

  it('lets the environment override config', () => {
    expect(resolveEmbeddedTerminalBackendConfig(
      { terminal: { embeddedBackend: 'pty' } },
      { INVOKER_EMBEDDED_TERMINAL_BACKEND: 'bash' },
    )).toBe('bash');
  });

  it('normalizes backend values', () => {
    expect(resolveEmbeddedTerminalBackendConfig(
      {},
      { INVOKER_EMBEDDED_TERMINAL_BACKEND: ' PTY ' },
    )).toBe('pty');
  });

  it('rejects invalid backend values', () => {
    expect(() => resolveEmbeddedTerminalBackendConfig(
      {},
      { INVOKER_EMBEDDED_TERMINAL_BACKEND: 'external' },
    )).toThrow(/Invalid embedded terminal backend/);
  });
});

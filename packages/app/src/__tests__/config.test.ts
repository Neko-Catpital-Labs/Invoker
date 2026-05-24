import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  resolveEmbeddedTerminalBackendConfig,
  resolveLaunchOutboxMode,
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
  it('returns config with default launchOutboxMode when no files exist', () => {
    const config = loadConfig();
    expect(config).toEqual({ launchOutboxMode: 'disabled' });
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

  it('reads externalFailureRecovery from user config', () => {
    const externalFailureRecovery = {
      enabled: true,
      command: '/usr/local/bin/recover.sh --verbose',
      cwd: '/var/lib/invoker',
      cooldownSeconds: 30,
    };
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ externalFailureRecovery }),
    );
    const config = loadConfig();
    expect(config.externalFailureRecovery).toEqual(externalFailureRecovery);
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

describe('resolveLaunchOutboxMode', () => {
  it('defaults to disabled when INVOKER_LAUNCH_OUTBOX is unset', () => {
    expect(resolveLaunchOutboxMode({})).toBe('disabled');
  });

  it('returns observe when INVOKER_LAUNCH_OUTBOX=observe', () => {
    expect(
      resolveLaunchOutboxMode({ INVOKER_LAUNCH_OUTBOX: 'observe' }),
    ).toBe('observe');
  });

  it('returns active when INVOKER_LAUNCH_OUTBOX=active', () => {
    expect(
      resolveLaunchOutboxMode({ INVOKER_LAUNCH_OUTBOX: 'active' }),
    ).toBe('active');
  });

  it('falls back to disabled with a warning for unknown values', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(
        resolveLaunchOutboxMode({ INVOKER_LAUNCH_OUTBOX: 'on' }),
      ).toBe('disabled');
      expect(warnSpy).toHaveBeenCalledOnce();
      expect(warnSpy.mock.calls[0]?.[0]).toMatch(/Unknown INVOKER_LAUNCH_OUTBOX/);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('is case- and whitespace-insensitive', () => {
    expect(
      resolveLaunchOutboxMode({ INVOKER_LAUNCH_OUTBOX: '  Observe  ' }),
    ).toBe('observe');
  });
});

import type * as NodeOs from 'node:os';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveInvokerConfigPath } from '@invoker/contracts';
import {
  loadConfig,
  resolveAutoFixExecutionModel,
  resolveConfigFilePath,
  resolveDefaultExecutionAgent,
  resolveDefaultTaskExecutionSettings,
  resolveConflictResolutionSettings,
  resolveEmbeddedTerminalBackendConfig,
} from '../config.js';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const testDir = join(tmpdir(), `invoker-config-test-${process.pid}`);
const fakeHome = join(testDir, 'home');
beforeEach(() => {
  delete process.env.INVOKER_REPO_CONFIG_PATH;
  mkdirSync(join(fakeHome, '.invoker'), { recursive: true });
});

afterEach(() => {
  delete process.env.INVOKER_REPO_CONFIG_PATH;
  rmSync(testDir, { recursive: true, force: true });
});

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeOs>();
  return {
    ...actual,
    homedir: () => `${actual.tmpdir()}/invoker-config-test-${process.pid}/home`,
  };
});

function writeUserConfig(value: unknown): void {
  writeFileSync(join(fakeHome, '.invoker', 'config.json'), JSON.stringify(value));
}

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

  it('reads experimentalPlanner from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ experimentalPlanner: true }),
    );
    const config = loadConfig();
    expect(config.experimentalPlanner).toBe(true);
  });

  it('reads autoFixAgent from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ autoFixAgent: 'codex' }),
    );
    const config = loadConfig();
    expect(config.autoFixAgent).toBe('codex');
  });
  it('reads defaultExecutionAgent from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultExecutionAgent: 'claude' }),
    );
    const config = loadConfig();
    expect(config.defaultExecutionAgent).toBe('claude');
    expect(resolveDefaultExecutionAgent(config)).toBe('claude');
  });

  it('falls back to the built-in default execution agent', () => {
    expect(resolveDefaultExecutionAgent({})).toBe('codex');
    expect(resolveDefaultExecutionAgent({ defaultExecutionAgent: '   ' })).toBe('codex');
  });


  it('reads default execution settings from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultExecutionAgent: 'omp', defaultExecutionModel: 'chatgpt-5.4' }),
    );
    const config = loadConfig();
    expect(config.defaultExecutionAgent).toBe('omp');
    expect(config.defaultExecutionModel).toBe('chatgpt-5.4');
  });

  it('resolves built-in task execution defaults when config values are blank', () => {
    expect(resolveDefaultTaskExecutionSettings({ defaultExecutionAgent: '  ', defaultExecutionModel: '   ' })).toEqual({
      executionAgent: 'codex',
    });
    expect(resolveDefaultTaskExecutionSettings({ defaultExecutionAgent: 'omp', defaultExecutionModel: 'chatgpt-5.4' })).toEqual({
      executionAgent: 'omp',
      executionModel: 'chatgpt-5.4',
    });
  });
  it('only reuses the default model when auto-fix stays on the default agent', () => {
    expect(resolveAutoFixExecutionModel({
      autoFixAgent: 'omp',
      defaultExecutionAgent: 'omp',
      defaultExecutionModel: 'chatgpt-5.4',
    })).toBe('chatgpt-5.4');
    expect(resolveAutoFixExecutionModel({
      autoFixAgent: 'codex',
      defaultExecutionAgent: 'omp',
      defaultExecutionModel: 'chatgpt-5.4',
    })).toBeUndefined();
    expect(resolveAutoFixExecutionModel({
      defaultExecutionAgent: 'omp',
      defaultExecutionModel: 'chatgpt-5.4',
    })).toBeUndefined();
  });

  it('reads conflict resolution settings from user config', () => {
    writeUserConfig({
      conflictResolutionAgent: 'omp',
      conflictResolutionModel: 'gpt-5-mini',
    });
    const config = loadConfig();
    expect(config.conflictResolutionAgent).toBe('omp');
    expect(config.conflictResolutionModel).toBe('gpt-5-mini');
  });

  it('resolves conflict resolution settings with explicit, config, and path defaults', () => {
    expect(resolveConflictResolutionSettings({})).toEqual({});
    expect(resolveConflictResolutionSettings(
      { conflictResolutionModel: 'gpt-5-mini' },
      { pathDefaultAgent: 'codex' },
    )).toEqual({ agent: 'codex', model: 'gpt-5-mini' });
    expect(resolveConflictResolutionSettings(
      { conflictResolutionAgent: 'omp', conflictResolutionModel: 'gpt-5-mini' },
      { pathDefaultAgent: 'codex' },
    )).toEqual({ agent: 'omp', model: 'gpt-5-mini' });
    expect(resolveConflictResolutionSettings(
      { conflictResolutionAgent: 'omp', conflictResolutionModel: 'gpt-5-mini' },
      { explicitAgent: 'claude', pathDefaultAgent: 'codex' },
    )).toEqual({ agent: 'claude', model: 'gpt-5-mini' });
    expect(resolveConflictResolutionSettings(
      { conflictResolutionAgent: '  ', conflictResolutionModel: '  ' },
      { pathDefaultAgent: 'codex' },
    )).toEqual({ agent: 'codex' });
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

  it('defaults externalWorkers to none when absent', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig();
    expect(config.externalWorkers).toBeUndefined();
  });

  it('reads external worker launch config from user config', () => {
    const externalWorkers = [{
      kind: 'preview',
      launch: {
        executable: '/usr/local/bin/invoker-preview-worker',
        args: ['--stdio', '--log-level=info'],
        cwd: '/srv/invoker',
      },
    }];
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ externalWorkers }),
    );
    const config = loadConfig();
    expect(config.externalWorkers).toEqual(externalWorkers);
  });

  it('defaults prMaintenance to undefined when absent', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig();
    expect(config.prMaintenance).toBeUndefined();
  });

  it('reads prMaintenance config from user config', () => {
    const prMaintenance = {
      enabled: true,
      repoRoot: '/srv/invoker',
      env: { INVOKER_PR_CRON_LOCK: '/tmp/pr.lock' },
      intervalMs: 120000,
      lockPath: '/tmp/pr.lock',
      shell: '/bin/bash',
    };
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ prMaintenance }),
    );
    const config = loadConfig();
    expect(config.prMaintenance).toEqual(prMaintenance);
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

  it('reads defaultPoolId from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultPoolId: 'mixed-local-ssh' }),
    );
    const config = loadConfig();
    expect(config.defaultPoolId).toBe('mixed-local-ssh');
  });
  it('reads defaultExecution from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({
        defaultExecution: {
          executionAgent: 'omp',
          executionModel: 'anthropic/claude-opus-4',
        },
      }),
    );
    const config = loadConfig();
    expect(config.defaultExecution).toEqual({
      executionAgent: 'omp',
      executionModel: 'anthropic/claude-opus-4',
    });
  });

  it('rejects defaultExecution model without an agent', () => {
    writeUserConfig({
      defaultExecution: {
        executionModel: 'anthropic/claude-opus-4',
      },
    });
    expect(() => loadConfig()).toThrow('defaultExecution.executionModel requires defaultExecution.executionAgent');
  });
  it('rejects flat defaultExecutionModel without an agent', () => {
    writeUserConfig({
      defaultExecutionModel: 'claude',
    });
    expect(() => loadConfig()).toThrow('defaultExecutionModel requires defaultExecutionAgent');
  });

  it('rejects mismatched flat default execution pairs for builtin agents', () => {
    writeUserConfig({
      defaultExecutionAgent: 'codex',
      defaultExecutionModel: 'claude',
    });
    expect(() => loadConfig()).toThrow(
      'Execution model "claude" is not supported for execution agent "codex".',
    );
  });


  it('treats a blank env config path override as unset', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    process.env.INVOKER_REPO_CONFIG_PATH = '   ';
    const expected = join(fakeHome, '.invoker', 'config.json');
    expect(resolveInvokerConfigPath(process.env, fakeHome)).toBe(expected);
    expect(resolveConfigFilePath()).toBe(expected);
    expect(loadConfig().defaultBranch).toBe('main');
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


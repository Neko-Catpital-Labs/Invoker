import type * as NodeOs from 'node:os';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveInvokerConfigPath } from '@invoker/contracts';
import {
  BUILT_IN_LOCAL_EXECUTION_POOL_ID,
  BUILT_IN_LOCAL_WORKTREE_TARGET_ID,
  filterExecutionHarnesses,
  filterPlanningPresets,
  loadConfig,
  materializeResolvedConfig,
  resolveAutoFixExecutionModel,
  resolveAutoFixPoolId,
  resolveConfigFilePath,
  resolveDefaultExecutionAgent,
  resolveDefaultTaskExecutionSettings,
  resolveConflictResolutionSettings,
  resolveEmbeddedTerminalBackendConfig,
  resolveEnabledExecutionAgents,
  resolvePrMaintenanceTargetRepos,
  resolvePrMaintenanceWorkerConfig,
  resolveE2eAutoFixTargetRepos,
  resolveE2eAutoFixWorkerConfig,
  DEFAULT_PR_MAINTENANCE_TARGET_REPO,
  DEFAULT_E2E_AUTOFIX_TARGET_REPO,
} from '../config.js';
import { validateInvokerConfig } from '../config-validation.js';
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
  it.each([
    ['missing config file', false],
    ['empty config object', true],
  ])('materializes the built-in local worktree pool for %s', (_label, writeEmptyConfig) => {
    if (writeEmptyConfig) writeUserConfig({});

    const config = loadConfig();
    expect(config.worktreeTargets).toEqual({
      [BUILT_IN_LOCAL_WORKTREE_TARGET_ID]: {},
    });
    expect(config.executionPools).toEqual({
      [BUILT_IN_LOCAL_EXECUTION_POOL_ID]: {
        members: [{ type: 'worktree', id: BUILT_IN_LOCAL_WORKTREE_TARGET_ID }],
      },
    });
    expect(config.defaultPoolId).toBe(BUILT_IN_LOCAL_EXECUTION_POOL_ID);
  });

  it('preserves explicit pools and explicit defaultPoolId while adding the built-in pool', () => {
    writeUserConfig({
      worktreeTargets: {
        custom: { maxConcurrentTasks: 3 },
      },
      executionPools: {
        custom: {
          members: [{ type: 'worktree', id: 'custom' }],
        },
      },
      defaultPoolId: 'custom',
    });

    const config = loadConfig();
    expect(config.worktreeTargets?.custom).toEqual({ maxConcurrentTasks: 3 });
    expect(config.executionPools?.custom).toEqual({
      members: [{ type: 'worktree', id: 'custom' }],
    });
    expect(config.executionPools?.[BUILT_IN_LOCAL_EXECUTION_POOL_ID]).toEqual({
      members: [{ type: 'worktree', id: BUILT_IN_LOCAL_WORKTREE_TARGET_ID }],
    });
    expect(config.defaultPoolId).toBe('custom');
  });

  it('accepts structurally identical reserved entries and materializes idempotently', () => {
    const source = {
      worktreeTargets: {
        [BUILT_IN_LOCAL_WORKTREE_TARGET_ID]: {},
      },
      executionPools: {
        [BUILT_IN_LOCAL_EXECUTION_POOL_ID]: {
          members: [{ type: 'worktree' as const, id: BUILT_IN_LOCAL_WORKTREE_TARGET_ID }],
        },
      },
    };

    const resolved = materializeResolvedConfig(source);
    expect(materializeResolvedConfig(resolved)).toEqual(resolved);
    expect(source).toEqual({
      worktreeTargets: { [BUILT_IN_LOCAL_WORKTREE_TARGET_ID]: {} },
      executionPools: {
        [BUILT_IN_LOCAL_EXECUTION_POOL_ID]: {
          members: [{ type: 'worktree', id: BUILT_IN_LOCAL_WORKTREE_TARGET_ID }],
        },
      },
    });
  });

  it.each([
    [
      'worktree target',
      {
        worktreeTargets: {
          [BUILT_IN_LOCAL_WORKTREE_TARGET_ID]: { maxConcurrentTasks: 2 },
        },
      },
    ],
    [
      'execution pool',
      {
        executionPools: {
          [BUILT_IN_LOCAL_EXECUTION_POOL_ID]: {
            members: [{ type: 'worktree' as const, id: 'custom' }],
          },
        },
      },
    ],
  ])('fails closed for a conflicting reserved built-in %s', (_label, config) => {
    expect(() => materializeResolvedConfig(config)).toThrow(/is reserved for Invoker's built-in local/);
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

  it('reads enabledExecutionAgents from user config', () => {
    writeUserConfig({ enabledExecutionAgents: ['claude', 'omp'] });
    expect(loadConfig().enabledExecutionAgents).toEqual(['claude', 'omp']);
  });

  it('rejects non-array enabledExecutionAgents', () => {
    writeUserConfig({ enabledExecutionAgents: 'claude' });
    expect(() => loadConfig()).toThrow(/enabledExecutionAgents must be an array/);
  });

  it('rejects empty or non-string enabledExecutionAgents entries', () => {
    writeUserConfig({ enabledExecutionAgents: ['claude', '  '] });
    expect(() => loadConfig()).toThrow(/non-empty strings/);
    writeUserConfig({ enabledExecutionAgents: [42] });
    expect(() => loadConfig()).toThrow(/non-empty strings/);
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
  it('prefers an explicit autoFixExecutionModel over the fleet default, scoped to auto-fix only', () => {
    expect(resolveAutoFixExecutionModel({
      autoFixAgent: 'cursor',
      autoFixExecutionModel: 'grok-4.5',
      defaultExecutionAgent: 'codex',
      defaultExecutionModel: 'gpt-5.5',
    })).toBe('grok-4.5');
    // Fleet defaults are untouched — a task without autoFixAgent still resolves to codex/gpt-5.5.
    expect(resolveDefaultTaskExecutionSettings({
      defaultExecutionAgent: 'codex',
      defaultExecutionModel: 'gpt-5.5',
    })).toEqual({ executionAgent: 'codex', executionModel: 'gpt-5.5' });
  });
  it('resolves autoFixPoolId independently of defaultPoolId', () => {
    expect(resolveAutoFixPoolId({ autoFixPoolId: 'remote_digital_ocean_1' })).toBe('remote_digital_ocean_1');
    expect(resolveAutoFixPoolId({ autoFixPoolId: '  ' })).toBeUndefined();
    expect(resolveAutoFixPoolId({})).toBeUndefined();
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

  it('defaults diskHeadroom to undefined when absent', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig();
    expect(config.diskHeadroom).toBeUndefined();
  });

  it('reads diskHeadroom.cleanupEnabled from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ diskHeadroom: { cleanupEnabled: false } }),
    );
    const config = loadConfig();
    expect(config.diskHeadroom).toEqual({ cleanupEnabled: false });
  });

  it('loads adminBypassE2eBabysit with positive numeric values', () => {
    const adminBypassE2eBabysit = {
      enabled: true,
      intervalMinutes: 5,
      watchedWorkerKinds: ['pr-admin-bypass-land', 'e2e-autofix'],
      staleTtlMinutes: 30,
    };
    writeUserConfig({ adminBypassE2eBabysit });

    expect(loadConfig().adminBypassE2eBabysit).toEqual(adminBypassE2eBabysit);
  });

  it.each([0, -1])('rejects adminBypassE2eBabysit.intervalMinutes of %s', (intervalMinutes) => {
    writeUserConfig({ adminBypassE2eBabysit: { intervalMinutes } });

    expect(() => loadConfig()).toThrow(
      /adminBypassE2eBabysit.intervalMinutes must be an integer > 0/,
    );
  });

  it.each([0, -1])('rejects adminBypassE2eBabysit.staleTtlMinutes of %s', (staleTtlMinutes) => {
    writeUserConfig({ adminBypassE2eBabysit: { staleTtlMinutes } });

    expect(() => loadConfig()).toThrow(
      /adminBypassE2eBabysit.staleTtlMinutes must be an integer > 0/,
    );
  });

  it.each([
    { shape: 'null', value: null },
    { shape: 'array', value: [] },
    { shape: 'boolean', value: true },
    { shape: 'number', value: 1 },
    { shape: 'string', value: 'invalid' },
  ])('rejects malformed adminBypassE2eBabysit shape: $shape', ({ value: adminBypassE2eBabysit }) => {
    writeUserConfig({ adminBypassE2eBabysit });

    expect(() => loadConfig()).toThrow(/adminBypassE2eBabysit must be an object/);
  });

  it('loads config when adminBypassE2eBabysit is omitted', () => {
    writeUserConfig({ defaultBranch: 'main' });

    expect(loadConfig().adminBypassE2eBabysit).toBeUndefined();
  });

  it('defaults removed opt-in worker gates to undefined when absent', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({ defaultBranch: 'main' }),
    );
    const config = loadConfig() as Record<string, unknown>;
    expect(config.infraRepair).toBeUndefined();
    expect(config.autofix).toBeUndefined();
    expect(config.reaper).toBeUndefined();
    expect(config.workflowResume).toBeUndefined();
    expect(config.requeueEnabled).toBeUndefined();
    expect(config.e2eAutoFixEnabled).toBeUndefined();
  });

  it('ignores leftover opt-in worker start flags in JSON (migration reads them separately)', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({
        infraRepair: { enabled: true },
        autofix: { enabled: true },
        reaper: { enabled: false },
        workflowResume: { enabled: true },
        requeueEnabled: true,
        e2eAutoFixEnabled: true,
      }),
    );
    const config = loadConfig() as Record<string, unknown>;
    // loadConfig casts JSON through; leftover keys may still appear at runtime
    // but are not InvokerConfig start gates and must not affect auto-start.
    expect(config.infraRepair).toEqual({ enabled: true });
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
  it('reads target-owned provisioning keys from user config', () => {
    writeFileSync(
      join(fakeHome, '.invoker', 'config.json'),
      JSON.stringify({
        remoteTargets: {
          ssh: {
            host: '203.0.113.10',
            user: 'invoker',
            sshKeyPath: '/home/you/.ssh/id_ed25519',
            provisionCommand: 'bash scripts/provision-ssh-worker.sh ensure-repo-ready',
          },
        },
        worktreeTargets: {
          local: {
            provisionCommand: 'pnpm install --frozen-lockfile',
            maxConcurrentTasks: 2,
          },
        },
      }),
    );
    const config = loadConfig();
    expect(config.remoteTargets?.ssh?.provisionCommand).toBe('bash scripts/provision-ssh-worker.sh ensure-repo-ready');
    expect(config.worktreeTargets).toEqual({
      local: {
        provisionCommand: 'pnpm install --frozen-lockfile',
        maxConcurrentTasks: 2,
      },
      [BUILT_IN_LOCAL_WORKTREE_TARGET_ID]: {},
    });
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

describe('resolveEnabledExecutionAgents', () => {
  it('returns null when the field is unset', () => {
    expect(resolveEnabledExecutionAgents({})).toBeNull();
  });

  it('returns null when the field is empty or whitespace-only', () => {
    expect(resolveEnabledExecutionAgents({ enabledExecutionAgents: [] })).toBeNull();
    expect(resolveEnabledExecutionAgents({ enabledExecutionAgents: ['  ', ''] })).toBeNull();
  });

  it('trims and lowercases entries and drops empty ones', () => {
    expect(resolveEnabledExecutionAgents({ enabledExecutionAgents: ['  Claude ', 'OMP', ''] }))
      .toEqual(new Set(['claude', 'omp']));
  });
});

describe('filterExecutionHarnesses', () => {
  const harnesses = [
    { name: 'claude', supportedModels: [] },
    { name: 'codex', supportedModels: [] },
    { name: 'omp', supportedModels: [] },
  ];

  it('returns the input unchanged when no allowlist is configured', () => {
    expect(filterExecutionHarnesses(harnesses, {})).toEqual(harnesses);
    expect(filterExecutionHarnesses(harnesses, { enabledExecutionAgents: [] })).toEqual(harnesses);
  });

  it('drops harnesses missing from the allowlist', () => {
    expect(filterExecutionHarnesses(harnesses, { enabledExecutionAgents: ['claude'] }))
      .toEqual([{ name: 'claude', supportedModels: [] }]);
  });

  it('matches case-insensitively with whitespace tolerated', () => {
    expect(filterExecutionHarnesses(harnesses, { enabledExecutionAgents: [' CLAUDE ', 'Omp'] }))
      .toEqual([
        { name: 'claude', supportedModels: [] },
        { name: 'omp', supportedModels: [] },
      ]);
  });
});

describe('filterPlanningPresets', () => {
  const presets = [
    { key: 'claude', tool: 'claude', model: undefined },
    { key: 'codex', tool: 'codex', model: undefined },
    { key: 'cursor+claude', tool: 'cursor', model: 'claude' },
    { key: 'cursor+codex', tool: 'cursor', model: 'codex' },
    { key: 'omp+claude', tool: 'omp', model: 'claude' },
  ];

  it('returns the input unchanged when no allowlist is configured', () => {
    expect(filterPlanningPresets(presets, {})).toEqual(presets);
  });

  it('keeps direct-tool presets and wrapper presets whose model is allowed', () => {
    expect(filterPlanningPresets(presets, { enabledExecutionAgents: ['claude'] }).map((p) => p.key))
      .toEqual(['claude', 'cursor+claude', 'omp+claude']);
  });

  it('drops wrapper presets whose model is not allowed', () => {
    expect(filterPlanningPresets(presets, { enabledExecutionAgents: ['codex'] }).map((p) => p.key))
      .toEqual(['codex', 'cursor+codex']);
  });

  it('does not treat a non-wrapper tool model as an allowlist match', () => {
    const custom = [{ key: 'x', tool: 'someplanner', model: 'claude' }];
    expect(filterPlanningPresets(custom, { enabledExecutionAgents: ['claude'] })).toEqual([]);
  });

  it('normalizes allowlist whitespace and case', () => {
    expect(filterPlanningPresets(presets, { enabledExecutionAgents: [' Claude '] }).map((p) => p.key))
      .toEqual(['claude', 'cursor+claude', 'omp+claude']);
  });
});

describe('prMaintenance.targetRepos', () => {
  it('reads targetRepos from config', () => {
    expect(resolvePrMaintenanceTargetRepos({
      prMaintenance: {
        targetRepos: ['Neko-Catpital-Labs/Invoker', 'EdbertChan/catstack'],
      },
    })).toEqual(['Neko-Catpital-Labs/Invoker', 'EdbertChan/catstack']);
  });

  it('defaults to the Invoker repo when targetRepos is omitted', () => {
    expect(resolvePrMaintenanceTargetRepos({})).toEqual([DEFAULT_PR_MAINTENANCE_TARGET_REPO]);
    expect(resolvePrMaintenanceTargetRepos({
      prMaintenance: { targetRepos: [] },
    })).toEqual([DEFAULT_PR_MAINTENANCE_TARGET_REPO]);
  });

  it('forwards config targetRepos into worker env for shell entrypoints', () => {
    const launch = resolvePrMaintenanceWorkerConfig({
      prMaintenance: {
        targetRepos: ['Neko-Catpital-Labs/Invoker', 'EdbertChan/catstack'],
        env: {
          INVOKER_GITHUB_TARGET_REPOS: 'should/not-win',
          INVOKER_GITHUB_TARGET_REPO: 'should/not-win',
        },
      },
    });
    expect(launch?.env?.INVOKER_GITHUB_TARGET_REPOS).toBe(
      'Neko-Catpital-Labs/Invoker,EdbertChan/catstack',
    );
    expect(launch?.env?.INVOKER_GITHUB_TARGET_REPO).toBe('Neko-Catpital-Labs/Invoker');
  });

  it('rejects invalid targetRepos entries', () => {
    expect(() => validateInvokerConfig({
      prMaintenance: { targetRepos: ['not-a-repo'] },
    })).toThrow(/owner\/repo/);
  });

  it('rejects targetRepos entries with disallowed punctuation', () => {
    expect(() => validateInvokerConfig({
      prMaintenance: { targetRepos: ['owner/bad?name'] },
    })).toThrow(/owner\/repo/);
  });

  it('rejects targetRepos entries containing a comma', () => {
    expect(() => validateInvokerConfig({
      prMaintenance: { targetRepos: ['owner,other/repo'] },
    })).toThrow(/owner\/repo/);
  });
});

describe('crossRepoResearch config', () => {
  it('accepts omitted crossRepoResearch block', () => {
    expect(validateInvokerConfig({})).toEqual({});
  });

  it('accepts empty maps without linearTeamId', () => {
    expect(validateInvokerConfig({
      crossRepoResearch: { maps: {} },
    }).crossRepoResearch?.maps).toEqual({});
  });

  it('requires linearTeamId when maps are non-empty', () => {
    expect(() => validateInvokerConfig({
      crossRepoResearch: {
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            'https://github.com/stablyai/orca',
          ],
        },
      },
    })).toThrow(/linearTeamId is required/);
  });

  it('rejects lookbackDays of 0', () => {
    expect(() => validateInvokerConfig({
      crossRepoResearch: {
        linearTeamId: 'team-1',
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            { repoUrl: 'https://github.com/stablyai/orca', lookbackDays: 0 },
          ],
        },
      },
    })).toThrow(/lookbackDays must be an integer > 0/);
  });

  it('accepts string sources and object sources with lookbackDays', () => {
    const config = validateInvokerConfig({
      crossRepoResearch: {
        intervalDays: 14,
        linearTeamId: 'team-1',
        maxCandidatesPerSource: 5,
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            'https://github.com/stablyai/orca',
            { repoUrl: 'https://github.com/example/other', lookbackDays: 7 },
          ],
        },
      },
    });
    expect(config.crossRepoResearch?.linearTeamId).toBe('team-1');
    expect(config.crossRepoResearch?.maps?.['https://github.com/Neko-Catpital-Labs/Invoker.git']).toHaveLength(2);
  });

  it('rejects non-git map keys', () => {
    expect(() => validateInvokerConfig({
      crossRepoResearch: {
        linearTeamId: 'team-1',
        maps: { 'not-a-url': ['https://github.com/stablyai/orca'] },
      },
    })).toThrow(/maps key must be a git URL/);
  });

  it.each([
    'https://github.com/owner',
    'git@example.com',
    'ssh://example.com',
  ])('rejects map keys with no repository path (%s)', (targetUrl) => {
    expect(() => validateInvokerConfig({
      crossRepoResearch: {
        linearTeamId: 'team-1',
        maps: { [targetUrl]: ['https://github.com/stablyai/orca'] },
      },
    })).toThrow(/maps key must be a git URL/);
  });

  it.each([
    'https://github.com/owner',
    'git@example.com',
    'ssh://example.com',
  ])('rejects string sources with no repository path (%s)', (sourceUrl) => {
    expect(() => validateInvokerConfig({
      crossRepoResearch: {
        linearTeamId: 'team-1',
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [sourceUrl],
        },
      },
    })).toThrow(/must be a git URL string/);
  });
});

describe('mergifyQueueResearch config', () => {
  it('accepts omitted mergifyQueueResearch block', () => {
    expect(validateInvokerConfig({})).toEqual({});
  });

  it('accepts empty maps without linearTeamId', () => {
    expect(validateInvokerConfig({
      mergifyQueueResearch: { maps: {} },
    }).mergifyQueueResearch?.maps).toEqual({});
  });

  it('requires linearTeamId when maps are non-empty', () => {
    expect(() => validateInvokerConfig({
      mergifyQueueResearch: {
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            'https://github.com/Neko-Catpital-Labs/Invoker.git',
          ],
        },
      },
    })).toThrow(/linearTeamId is required/);
  });

  it('rejects lookbackDays of 0', () => {
    expect(() => validateInvokerConfig({
      mergifyQueueResearch: {
        linearTeamId: 'team-1',
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            { repoUrl: 'https://github.com/Neko-Catpital-Labs/Invoker.git', lookbackDays: 0 },
          ],
        },
      },
    })).toThrow(/lookbackDays must be an integer > 0/);
  });

  it('accepts string sources and object sources with lookbackDays', () => {
    const config = validateInvokerConfig({
      mergifyQueueResearch: {
        intervalDays: 14,
        linearTeamId: 'team-1',
        maxCandidatesPerSource: 5,
        maps: {
          'https://github.com/Neko-Catpital-Labs/Invoker.git': [
            'https://github.com/Neko-Catpital-Labs/Invoker.git',
            { repoUrl: 'https://github.com/example/other', lookbackDays: 7 },
          ],
        },
      },
    });
    expect(config.mergifyQueueResearch?.linearTeamId).toBe('team-1');
    expect(config.mergifyQueueResearch?.maps?.['https://github.com/Neko-Catpital-Labs/Invoker.git']).toHaveLength(2);
  });

  it('rejects non-git map keys', () => {
    expect(() => validateInvokerConfig({
      mergifyQueueResearch: {
        linearTeamId: 'team-1',
        maps: { 'not-a-url': ['https://github.com/Neko-Catpital-Labs/Invoker.git'] },
      },
    })).toThrow(/maps key must be a git URL/);
  });
});

describe('catstackDeploy config', () => {
  it('accepts omitted catstackDeploy block', () => {
    expect(validateInvokerConfig({})).toEqual({});
  });

  it('accepts a valid intervalMinutes and paths', () => {
    const config = validateInvokerConfig({
      catstackDeploy: {
        intervalMinutes: 15,
        repoUrl: 'https://github.com/EdbertChan/catstack.git',
        localRepoPath: '~/Documents/GitHub/catstack',
        remoteRepoPath: '~/Documents/GitHub/catstack',
      },
    });
    expect(config.catstackDeploy?.intervalMinutes).toBe(15);
  });

  it('rejects intervalMinutes of 0', () => {
    expect(() => validateInvokerConfig({
      catstackDeploy: { intervalMinutes: 0 },
    })).toThrow(/catstackDeploy.intervalMinutes must be an integer > 0/);
  });

  it('rejects non-integer intervalMinutes', () => {
    expect(() => validateInvokerConfig({
      catstackDeploy: { intervalMinutes: 1.5 },
    })).toThrow(/catstackDeploy.intervalMinutes must be an integer > 0/);
  });
});

describe('dbReaper config', () => {
  it('accepts omitted dbReaper block', () => {
    expect(validateInvokerConfig({})).toEqual({});
  });

  it('accepts valid intervalMinutes and retention days', () => {
    const config = validateInvokerConfig({
      dbReaper: { intervalMinutes: 60, eventsRetentionDays: 14, syncJournalRetentionDays: 14 },
    });
    expect(config.dbReaper?.intervalMinutes).toBe(60);
    expect(config.dbReaper?.eventsRetentionDays).toBe(14);
    expect(config.dbReaper?.syncJournalRetentionDays).toBe(14);
  });

  it('accepts a non-positive retention day value as a disable signal', () => {
    const config = validateInvokerConfig({
      dbReaper: { eventsRetentionDays: 0, syncJournalRetentionDays: -1 },
    });
    expect(config.dbReaper?.eventsRetentionDays).toBe(0);
    expect(config.dbReaper?.syncJournalRetentionDays).toBe(-1);
  });

  it('rejects intervalMinutes of 0', () => {
    expect(() => validateInvokerConfig({
      dbReaper: { intervalMinutes: 0 },
    })).toThrow(/dbReaper.intervalMinutes must be an integer > 0/);
  });

  it('rejects non-integer intervalMinutes', () => {
    expect(() => validateInvokerConfig({
      dbReaper: { intervalMinutes: 1.5 },
    })).toThrow(/dbReaper.intervalMinutes must be an integer > 0/);
  });

  it('rejects a non-integer eventsRetentionDays', () => {
    expect(() => validateInvokerConfig({
      dbReaper: { eventsRetentionDays: 1.5 },
    })).toThrow(/dbReaper.eventsRetentionDays must be an integer/);
  });

  it('rejects a non-integer syncJournalRetentionDays', () => {
    expect(() => validateInvokerConfig({
      dbReaper: { syncJournalRetentionDays: 1.5 },
    })).toThrow(/dbReaper.syncJournalRetentionDays must be an integer/);
  });
});

describe('e2eAutoFix.targetRepos', () => {
  it('reads targetRepos from config', () => {
    expect(resolveE2eAutoFixTargetRepos({
      e2eAutoFix: {
        targetRepos: ['Neko-Catpital-Labs/Invoker', 'EdbertChan/catstack'],
      },
    })).toEqual(['Neko-Catpital-Labs/Invoker', 'EdbertChan/catstack']);
  });

  it('defaults to the Invoker repo when targetRepos is omitted', () => {
    expect(resolveE2eAutoFixTargetRepos({})).toEqual([DEFAULT_E2E_AUTOFIX_TARGET_REPO]);
    expect(resolveE2eAutoFixTargetRepos({
      e2eAutoFix: { targetRepos: [] },
    })).toEqual([DEFAULT_E2E_AUTOFIX_TARGET_REPO]);
  });

  it('forwards config targetRepos into worker env for the shell entrypoint', () => {
    const launch = resolveE2eAutoFixWorkerConfig({
      e2eAutoFix: {
        targetRepos: ['Neko-Capital-Labs/Invoker', 'EdbertChan/catstack'],
        env: {
          INVOKER_GITHUB_TARGET_REPOS: 'should/not-win',
          INVOKER_GITHUB_TARGET_REPO: 'should/not-win',
        },
      },
    });
    expect(launch.env?.INVOKER_GITHUB_TARGET_REPOS).toBe(
      'Neko-Capital-Labs/Invoker,EdbertChan/catstack',
    );
    expect(launch.env?.INVOKER_GITHUB_TARGET_REPO).toBe('Neko-Capital-Labs/Invoker');
  });

  it('defaults to watching only Invoker when e2eAutoFix is omitted', () => {
    const launch = resolveE2eAutoFixWorkerConfig({});
    expect(launch.env?.INVOKER_GITHUB_TARGET_REPOS).toBe(DEFAULT_E2E_AUTOFIX_TARGET_REPO);
    expect(launch.env?.INVOKER_GITHUB_TARGET_REPO).toBe(DEFAULT_E2E_AUTOFIX_TARGET_REPO);
    expect(launch.intervalMs).toBeUndefined();
  });

  it('carries the flat e2eAutoFixIntervalMs through unchanged', () => {
    const launch = resolveE2eAutoFixWorkerConfig({ e2eAutoFixIntervalMs: 60_000 });
    expect(launch.intervalMs).toBe(60_000);
  });

  it('rejects invalid targetRepos entries', () => {
    expect(() => validateInvokerConfig({
      e2eAutoFix: { targetRepos: ['not-a-repo'] },
    })).toThrow(/owner\/repo/);
  });

  it('rejects targetRepos entries containing a comma', () => {
    expect(() => validateInvokerConfig({
      e2eAutoFix: { targetRepos: ['owner,other/repo'] },
    })).toThrow(/owner\/repo/);
  });
});

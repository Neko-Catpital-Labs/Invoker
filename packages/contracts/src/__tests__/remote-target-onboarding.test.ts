import { describe, expect, it, vi } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  type RemoteTargetConnectivityResult,
  type RemoteTargetInput,
} from '../remote-target-onboarding.js';

const stagingTarget = {
  host: '192.168.1.100',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_staging',
  port: 22,
  maxConcurrentTasks: 1,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

const newTargetInput: RemoteTargetInput = {
  id: 'build-server-b',
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 2222,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

function baseConfig() {
  return {
    maxConcurrency: 6,
    defaultExecutionAgent: 'codex',
    remoteTargets: { 'staging-server': { ...stagingTarget } },
    executionPools: {
      'ssh-only': {
        members: [{ type: 'ssh', id: 'staging-server' }],
        selectionStrategy: 'roundRobin',
      },
    },
    defaultPoolId: 'ssh-only',
  };
}

describe('addRemoteTarget', () => {
  it('appends the new target and leaves every other field and entry unchanged', () => {
    const config = baseConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, newTargetInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.remoteTargets).toEqual({
      'staging-server': stagingTarget,
      'build-server-b': {
        host: '192.168.1.101',
        user: 'deploy',
        sshKeyPath: '/home/user/.ssh/id_build_b',
        port: 2222,
        maxConcurrentTasks: 2,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    });

    const remoteTargets = result.config.remoteTargets as Record<string, unknown>;
    expect(remoteTargets['staging-server']).toBe(config.remoteTargets['staging-server']);
    expect(result.config.executionPools).toBe(config.executionPools);
    expect(result.config.maxConcurrency).toBe(6);
    expect(result.config.defaultPoolId).toBe('ssh-only');

    expect(result.config).not.toBe(config);
    expect(JSON.stringify(config)).toBe(before);
  });

  it('creates remoteTargets when the config has none', () => {
    const config = { maxConcurrency: 2 };

    const result = addRemoteTarget(config, newTargetInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.remoteTargets as Record<string, unknown>)).toEqual(['build-server-b']);
    expect(config).toEqual({ maxConcurrency: 2 });
  });

  it('omits optional fields that were not provided', () => {
    const result = addRemoteTarget({}, {
      id: 'minimal',
      host: '10.0.0.5',
      user: 'ci',
      sshKeyPath: '/home/ci/.ssh/id_ed25519',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.config.remoteTargets as Record<string, unknown>).minimal).toEqual({
      host: '10.0.0.5',
      user: 'ci',
      sshKeyPath: '/home/ci/.ssh/id_ed25519',
    });
  });

  it('rejects a target whose host is already configured', () => {
    const config = baseConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...newTargetInput, id: 'staging-clone', host: '192.168.1.100' });

    expect(result).toEqual({
      ok: false,
      code: 'duplicate-host',
      message: 'remoteTargets.staging-server already uses host "192.168.1.100"',
    });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects a target whose id is already configured', () => {
    const result = addRemoteTarget(baseConfig(), { ...newTargetInput, id: 'staging-server' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('duplicate-target-id');
  });

  it('rejects a config whose remoteTargets is not an object', () => {
    const result = addRemoteTarget({ remoteTargets: [] }, newTargetInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('invalid-remote-targets');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const connection = {
    host: '192.168.1.101',
    user: 'deploy',
    sshKeyPath: '/home/user/.ssh/id_build_b',
    port: 2222,
  };

  it('uses the injected impl instead of the real SSH probe', async () => {
    const outcome: RemoteTargetConnectivityResult = { reachable: true, detail: 'stubbed ok' };
    const impl = vi.fn().mockResolvedValue(outcome);

    const result = await checkRemoteTargetConnectivity(connection, { impl });

    expect(result).toEqual(outcome);
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(connection);
  });

  it('supports a synchronous injected impl reporting unreachable', async () => {
    const result = await checkRemoteTargetConnectivity(connection, {
      impl: () => ({ reachable: false, detail: 'connection refused' }),
    });

    expect(result).toEqual({ reachable: false, detail: 'connection refused' });
  });

  it('propagates injected impl failures to the caller', async () => {
    await expect(
      checkRemoteTargetConnectivity(connection, {
        impl: () => Promise.reject(new Error('probe crashed')),
      }),
    ).rejects.toThrow('probe crashed');
  });
});

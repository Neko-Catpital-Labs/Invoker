import { describe, expect, it, vi } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  type AddRemoteTargetInput,
  type RemoteTargetSpec,
} from '../remote-target-onboarding.js';

const stagingTarget = {
  host: '192.168.1.100',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_staging',
  port: 22,
  maxConcurrentTasks: 1,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

function baseConfig() {
  return {
    maxConcurrency: 6,
    defaultExecutionAgent: 'codex',
    remoteTargets: {
      'staging-server': { ...stagingTarget },
    },
    executionPools: {
      'mixed-local-ssh': {
        members: [{ type: 'ssh', id: 'staging-server' }],
        selectionStrategy: 'roundRobin',
      },
    },
  };
}

const newTarget: AddRemoteTargetInput = {
  id: 'build-server-b',
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 2222,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

describe('addRemoteTarget', () => {
  it('appends the new target and keeps everything else byte-for-byte unchanged', () => {
    const config = baseConfig();
    const snapshot = JSON.stringify(config);

    const result = addRemoteTarget(config, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(config)).toBe(snapshot);
    expect(result.config).not.toBe(config);

    const targets = result.config.remoteTargets as Record<string, unknown>;
    expect(Object.keys(targets)).toEqual(['staging-server', 'build-server-b']);
    expect(targets['build-server-b']).toEqual({
      host: '192.168.1.101',
      user: 'deploy',
      sshKeyPath: '/home/user/.ssh/id_build_b',
      port: 2222,
      maxConcurrentTasks: 2,
      provisionCommand: 'pnpm install --frozen-lockfile',
    });

    expect(targets['staging-server']).toBe(config.remoteTargets['staging-server']);
    expect(result.config.executionPools).toBe(config.executionPools);
    expect(result.config.maxConcurrency).toBe(6);
    expect(result.config.defaultExecutionAgent).toBe('codex');
  });

  it('creates remoteTargets when the config has none', () => {
    const config = { maxConcurrency: 2 };

    const result = addRemoteTarget(config, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.remoteTargets).toEqual({
      'build-server-b': {
        host: '192.168.1.101',
        user: 'deploy',
        sshKeyPath: '/home/user/.ssh/id_build_b',
        port: 2222,
        maxConcurrentTasks: 2,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    });
    expect(config).toEqual({ maxConcurrency: 2 });
  });

  it('rejects a target whose host already exists instead of appending a second entry', () => {
    const config = baseConfig();
    const snapshot = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...newTarget, host: '192.168.1.100' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-host');
    expect(result.error.conflictingTargetId).toBe('staging-server');
    expect(result.error.message).toContain('192.168.1.100');
    expect(JSON.stringify(config)).toBe(snapshot);
  });

  it('rejects a target whose id already exists', () => {
    const config = baseConfig();

    const result = addRemoteTarget(config, { ...newTarget, id: 'staging-server' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-id');
    expect(result.error.conflictingTargetId).toBe('staging-server');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const target: RemoteTargetSpec = {
    host: '192.168.1.101',
    user: 'deploy',
    sshKeyPath: '/home/user/.ssh/id_build_b',
    port: 2222,
  };

  it('uses the injected impl instead of the real SSH probe', async () => {
    const impl = vi.fn().mockResolvedValue({ reachable: true, detail: 'stubbed ok' });

    const result = await checkRemoteTargetConnectivity(target, { impl });

    expect(result).toEqual({ reachable: true, detail: 'stubbed ok' });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(target);
  });

  it('returns the injected unreachable outcome deterministically', async () => {
    const result = await checkRemoteTargetConnectivity(target, {
      impl: () => ({ reachable: false, detail: 'stubbed connection refused' }),
    });

    expect(result).toEqual({ reachable: false, detail: 'stubbed connection refused' });
  });
});

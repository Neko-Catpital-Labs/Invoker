import { describe, expect, it, vi } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  type RemoteTargetInput,
  type RemoteTargetOnboardingConfig,
} from '../remote-target-onboarding.js';

const existingTarget: RemoteTargetInput = {
  host: '192.168.1.100',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_staging',
  port: 22,
  maxConcurrentTasks: 1,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

const newTarget: RemoteTargetInput = {
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 2222,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

function makeConfig(): RemoteTargetOnboardingConfig {
  return {
    maxConcurrency: 6,
    defaultExecutionAgent: 'codex',
    remoteTargets: [existingTarget],
    executionPools: {
      'mixed-local-ssh': {
        members: [{ type: 'ssh', id: 'staging-server' }],
        selectionStrategy: 'roundRobin',
      },
    },
  };
}

describe('addRemoteTarget', () => {
  it('appends the new target while leaving everything else unchanged', () => {
    const config = makeConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.remoteTargets).toEqual([existingTarget, newTarget]);
    expect(result.config.remoteTargets?.[0]).toBe(existingTarget);
    expect(result.config.executionPools).toBe(config.executionPools);
    expect(result.config.maxConcurrency).toBe(6);
    expect(result.config.defaultExecutionAgent).toBe('codex');
    expect(JSON.stringify(config)).toBe(before);
  });

  it('creates the remoteTargets array when it is absent', () => {
    const config: RemoteTargetOnboardingConfig = { maxConcurrency: 3 };
    const result = addRemoteTarget(config, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.remoteTargets).toEqual([newTarget]);
    expect(result.config.maxConcurrency).toBe(3);
    expect(config.remoteTargets).toBeUndefined();
  });

  it('rejects a duplicate host with a typed error instead of appending', () => {
    const config = makeConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...newTarget, host: existingTarget.host });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-host');
    expect(result.error.host).toBe(existingTarget.host);
    expect(result.error.message).toContain(existingTarget.host);
    expect(JSON.stringify(config)).toBe(before);
    expect(config.remoteTargets).toHaveLength(1);
  });
});

describe('checkRemoteTargetConnectivity', () => {
  it('uses the injected impl instead of a real SSH probe', async () => {
    const impl = vi.fn().mockResolvedValue({ reachable: true, detail: 'stubbed ok' });

    const result = await checkRemoteTargetConnectivity(newTarget, { impl });

    expect(result).toEqual({ reachable: true, detail: 'stubbed ok' });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(newTarget);
  });

  it('propagates an injected failure outcome', async () => {
    const result = await checkRemoteTargetConnectivity(newTarget, {
      impl: () => ({ reachable: false, detail: 'stubbed unreachable' }),
    });

    expect(result).toEqual({ reachable: false, detail: 'stubbed unreachable' });
  });
});

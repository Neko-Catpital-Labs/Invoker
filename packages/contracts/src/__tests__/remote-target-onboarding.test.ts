import { describe, expect, it, vi } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  sshProbeArgs,
  type RemoteTargetInput,
} from '../remote-target-onboarding.js';

const input: RemoteTargetInput = {
  name: 'staging-server',
  host: '192.168.1.100',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_staging',
  port: 22,
  maxConcurrentTasks: 1,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

const existingTarget = {
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 22,
};

const executionPools = {
  'pnpm-ssh': {
    members: [{ type: 'ssh', id: 'build-server-b' }],
    selectionStrategy: 'roundRobin',
  },
};

describe('addRemoteTarget', () => {
  it('creates remoteTargets and appends the machine when the section is absent', () => {
    const config = { maxConcurrency: 4 };

    const result = addRemoteTarget(config, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.remoteTargets).toEqual({
      'staging-server': {
        host: '192.168.1.100',
        user: 'deploy',
        sshKeyPath: '/home/user/.ssh/id_staging',
        port: 22,
        maxConcurrentTasks: 1,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    });
    expect(result.config.maxConcurrency).toBe(4);
    expect(config).toEqual({ maxConcurrency: 4 });
  });

  it('omits optional fields the input does not provide', () => {
    const result = addRemoteTarget({}, { name: 'box', host: 'h', user: 'u', sshKeyPath: '/k' });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.remoteTargets).toEqual({ box: { host: 'h', user: 'u', sshKeyPath: '/k' } });
  });

  it('appends alongside existing targets and leaves every other entry byte-for-byte unchanged', () => {
    const config = {
      maxConcurrency: 6,
      remoteTargets: { 'build-server-b': existingTarget },
      executionPools,
      defaultPoolId: 'pnpm-ssh',
    };
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, input);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.remoteTargets as object)).toEqual(['build-server-b', 'staging-server']);
    expect((result.config.remoteTargets as Record<string, unknown>)['build-server-b']).toBe(existingTarget);
    expect(result.config.executionPools).toBe(executionPools);
    expect(result.config.defaultPoolId).toBe('pnpm-ssh');
    expect(JSON.stringify((result.config.remoteTargets as Record<string, unknown>)['build-server-b'])).toBe(
      JSON.stringify(existingTarget),
    );
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects a duplicate host with a typed error instead of a second entry', () => {
    const config = { remoteTargets: { 'build-server-b': existingTarget } };
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...input, host: existingTarget.host });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'duplicate-host',
        message: 'remoteTargets.build-server-b already uses host "192.168.1.101"',
        conflictingTargetName: 'build-server-b',
      },
    });
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects a duplicate target name instead of overwriting the existing entry', () => {
    const config = { remoteTargets: { 'staging-server': existingTarget } };

    const result = addRemoteTarget(config, input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-name');
    expect(result.error.conflictingTargetName).toBe('staging-server');
  });

  it('rejects a config whose remoteTargets is not an object keyed by target id', () => {
    const result = addRemoteTarget({ remoteTargets: [existingTarget] }, input);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-remote-targets');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const target = { host: '192.168.1.100', user: 'deploy', sshKeyPath: '/home/user/.ssh/id_staging', port: 2222 };

  it('calls and returns the injected impl instead of running the real SSH probe', async () => {
    const impl = vi.fn().mockResolvedValue({ reachable: true, detail: 'stubbed ok' });

    const result = await checkRemoteTargetConnectivity(target, { impl });

    expect(result).toEqual({ reachable: true, detail: 'stubbed ok' });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(target);
  });

  it('propagates an unreachable outcome from the injected impl', async () => {
    const result = await checkRemoteTargetConnectivity(target, {
      impl: () => ({ reachable: false, detail: 'connection refused' }),
    });

    expect(result).toEqual({ reachable: false, detail: 'connection refused' });
  });

  it('builds the real probe from host, user, sshKeyPath, and port', () => {
    const args = sshProbeArgs(target, 5);

    expect(args).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=5',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-i',
      '/home/user/.ssh/id_staging',
      '-p',
      '2222',
      'deploy@192.168.1.100',
      'exit 0',
    ]);
  });
});

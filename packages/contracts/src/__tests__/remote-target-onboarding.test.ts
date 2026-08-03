import { describe, expect, it, vi } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  remoteTargetProbeArgs,
  type RemoteTargetSpec,
} from '../remote-target-onboarding.js';

const stagingServer = {
  host: '192.168.1.100',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_staging',
  port: 22,
  maxConcurrentTasks: 1,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

const baseConfig = {
  maxConcurrency: 6,
  defaultExecutionAgent: 'codex',
  remoteTargets: { 'staging-server': stagingServer },
  executionPools: {
    'mixed-local-ssh': {
      members: [{ type: 'ssh', id: 'staging-server' }],
      selectionStrategy: 'roundRobin',
    },
  },
};

const newTarget = {
  name: 'build-server-b',
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 22,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

describe('addRemoteTarget', () => {
  it('appends the new machine and leaves everything else byte-for-byte unchanged', () => {
    const before = JSON.stringify(baseConfig);
    const result = addRemoteTarget(baseConfig, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.config.remoteTargets).toEqual({
      'staging-server': stagingServer,
      'build-server-b': {
        host: '192.168.1.101',
        user: 'deploy',
        sshKeyPath: '/home/user/.ssh/id_build_b',
        port: 22,
        maxConcurrentTasks: 2,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    });

    expect(JSON.stringify(baseConfig)).toBe(before);
    expect(result.config).not.toBe(baseConfig);
    expect(result.config.maxConcurrency).toBe(baseConfig.maxConcurrency);
    expect(result.config.defaultExecutionAgent).toBe(baseConfig.defaultExecutionAgent);
    expect(result.config.executionPools).toBe(baseConfig.executionPools);
    expect((result.config.remoteTargets as Record<string, unknown>)['staging-server']).toBe(stagingServer);
  });

  it('creates the remoteTargets collection when it is absent', () => {
    const result = addRemoteTarget({ maxConcurrency: 2 }, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.remoteTargets as Record<string, unknown>)).toEqual(['build-server-b']);
    expect(result.config.maxConcurrency).toBe(2);
  });

  it('omits optional fields left undefined instead of writing undefined values', () => {
    const result = addRemoteTarget({}, { name: 'bare', host: 'h', user: 'u', sshKeyPath: '/k', port: undefined });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.config.remoteTargets as Record<string, unknown>).bare).toEqual({
      host: 'h',
      user: 'u',
      sshKeyPath: '/k',
    });
  });

  it('rejects a duplicate host with a typed error instead of adding a second entry', () => {
    const result = addRemoteTarget(baseConfig, { ...newTarget, host: stagingServer.host });

    expect(result).toEqual({
      ok: false,
      error: {
        code: 'duplicate-host',
        message: 'host "192.168.1.100" is already used by remote target "staging-server"',
      },
    });
    expect(Object.keys(baseConfig.remoteTargets)).toEqual(['staging-server']);
  });

  it('rejects a duplicate target name with a typed error', () => {
    const result = addRemoteTarget(baseConfig, { ...newTarget, name: 'staging-server' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-name');
    expect(baseConfig.remoteTargets['staging-server']).toBe(stagingServer);
  });

  it('rejects a config whose remoteTargets is not an object map', () => {
    const result = addRemoteTarget({ remoteTargets: [] }, newTarget);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-remote-targets');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const target: RemoteTargetSpec = {
    host: '192.168.1.101',
    user: 'deploy',
    sshKeyPath: '/home/user/.ssh/id_build_b',
    port: 2222,
  };

  it('calls the injected impl with the target and returns its outcome', async () => {
    const impl = vi.fn().mockResolvedValue({ ok: true });

    await expect(checkRemoteTargetConnectivity(target, { impl })).resolves.toEqual({ ok: true });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(target);
  });

  it('propagates a failing outcome from the injected impl', async () => {
    const impl = () => ({ ok: false, message: 'connection refused' });

    await expect(checkRemoteTargetConnectivity(target, { impl })).resolves.toEqual({
      ok: false,
      message: 'connection refused',
    });
  });

  it('builds the real ssh probe from host, user, sshKeyPath, and port', () => {
    expect(remoteTargetProbeArgs(target, 10)).toEqual([
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=accept-new',
      '-i',
      '/home/user/.ssh/id_build_b',
      '-p',
      '2222',
      'deploy@192.168.1.101',
      'true',
    ]);
  });

  it('omits the port flag when the target has no port', () => {
    const args = remoteTargetProbeArgs({ host: 'h', user: 'u', sshKeyPath: '/k' }, 5);

    expect(args).not.toContain('-p');
    expect(args.slice(-2)).toEqual(['u@h', 'true']);
  });
});

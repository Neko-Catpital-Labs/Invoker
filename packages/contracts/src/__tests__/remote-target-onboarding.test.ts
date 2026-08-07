import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';

import {
  addRemoteTarget,
  buildConnectivityProbeArgs,
  checkRemoteTargetConnectivity,
  REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR,
  type RemoteTargetInput,
} from '../remote-target-onboarding.js';

function createMockChildProcess() {
  const proc = new EventEmitter() as EventEmitter & { stderr: EventEmitter };
  proc.stderr = new EventEmitter();
  return proc;
}

const baseInput: RemoteTargetInput = {
  name: 'build-server-c',
  host: '192.168.1.102',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_c',
  port: 22,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

function existingConfig() {
  return {
    maxConcurrency: 6,
    remoteTargets: {
      'staging-server': {
        host: '192.168.1.100',
        user: 'deploy',
        sshKeyPath: '/home/user/.ssh/id_staging',
        port: 22,
        maxConcurrentTasks: 1,
        provisionCommand: 'pnpm install --frozen-lockfile',
      },
    },
    executionPools: {
      'mixed-local-ssh': {
        members: [{ type: 'ssh', id: 'staging-server' }],
        selectionStrategy: 'roundRobin',
        maxConcurrentTasksPerMember: 1,
      },
    },
    defaultPoolId: 'mixed-local-ssh',
  };
}

describe('addRemoteTarget', () => {
  it('appends the new target and leaves every existing field byte-for-byte unchanged', () => {
    const config = existingConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(config)).toBe(before);

    const targets = result.config.remoteTargets as Record<string, unknown>;
    expect(Object.keys(targets)).toEqual(['staging-server', 'build-server-c']);
    expect(JSON.stringify(targets['staging-server'])).toBe(
      JSON.stringify(existingConfig().remoteTargets['staging-server']),
    );
    expect(targets['build-server-c']).toEqual({
      host: '192.168.1.102',
      user: 'deploy',
      sshKeyPath: '/home/user/.ssh/id_build_c',
      port: 22,
      maxConcurrentTasks: 2,
      provisionCommand: 'pnpm install --frozen-lockfile',
    });

    expect(JSON.stringify(result.config.executionPools)).toBe(JSON.stringify(existingConfig().executionPools));
    expect(result.config.maxConcurrency).toBe(6);
    expect(result.config.defaultPoolId).toBe('mixed-local-ssh');
  });

  it('creates remoteTargets when the config has none', () => {
    const result = addRemoteTarget({ maxConcurrency: 2 }, baseInput);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.maxConcurrency).toBe(2);
    expect(Object.keys(result.config.remoteTargets as Record<string, unknown>)).toEqual(['build-server-c']);
  });

  it('omits optional fields that were not provided', () => {
    const result = addRemoteTarget({}, {
      name: 'minimal',
      host: 'minimal.example',
      user: 'ci',
      sshKeyPath: '/home/ci/.ssh/id_ed25519',
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const targets = result.config.remoteTargets as Record<string, unknown>;
    expect(targets.minimal).toEqual({
      host: 'minimal.example',
      user: 'ci',
      sshKeyPath: '/home/ci/.ssh/id_ed25519',
    });
  });

  it('rejects a host that is already configured instead of adding a second entry', () => {
    const config = existingConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...baseInput, host: '192.168.1.100' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-host');
    expect(result.error.conflictingTargetId).toBe('staging-server');
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects a target name that already exists instead of overwriting it', () => {
    const result = addRemoteTarget(existingConfig(), { ...baseInput, name: 'staging-server' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-name');
    expect(result.error.conflictingTargetId).toBe('staging-server');
  });

  it('rejects a malformed remoteTargets value', () => {
    const result = addRemoteTarget({ remoteTargets: ['not-a-record'] }, baseInput);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('invalid-remote-targets');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const target = {
    host: '192.168.1.102',
    user: 'deploy',
    sshKeyPath: '/home/user/.ssh/id_build_c',
    port: 2222,
  };

  afterEach(() => {
    delete process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR];
    vi.mocked(spawn).mockReset();
  });

  it('runs the real ssh probe when the stub env var is unset', async () => {
    const proc = createMockChildProcess();
    vi.mocked(spawn).mockReturnValue(proc as never);

    const resultPromise = checkRemoteTargetConnectivity(target);
    proc.emit('close', 0);
    const result = await resultPromise;

    expect(spawn).toHaveBeenCalledWith('ssh', buildConnectivityProbeArgs(target), expect.any(Object));
    expect(result).toEqual({ reachable: true, message: `ssh probe to ${target.user}@${target.host} succeeded` });
  });

  it('returns the scripted outcome for the host when the stub env var is set', async () => {
    process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR] = JSON.stringify({
      [target.host]: { reachable: true, message: 'scripted ok' },
    });

    const result = await checkRemoteTargetConnectivity(target);

    expect(result).toEqual({ reachable: true, message: 'scripted ok' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('returns a scripted failure instead of falling back to the real probe when the host has no entry', async () => {
    process.env[REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR] = JSON.stringify({
      'some-other-host': { reachable: true, message: 'scripted ok' },
    });

    const result = await checkRemoteTargetConnectivity(target);

    expect(result.reachable).toBe(false);
    expect(spawn).not.toHaveBeenCalled();
  });

  it('uses the injected impl instead of running a real SSH probe', async () => {
    const impl = vi.fn().mockResolvedValue({ reachable: true, message: 'stubbed ok' });

    const result = await checkRemoteTargetConnectivity(target, { impl });

    expect(result).toEqual({ reachable: true, message: 'stubbed ok' });
    expect(impl).toHaveBeenCalledTimes(1);
    expect(impl).toHaveBeenCalledWith(target);
  });

  it('propagates an unreachable outcome from the injected impl', async () => {
    const result = await checkRemoteTargetConnectivity(target, {
      impl: () => ({ reachable: false, message: 'connection refused' }),
    });

    expect(result).toEqual({ reachable: false, message: 'connection refused' });
  });

  it('builds a batch-mode ssh probe from the target connection settings', () => {
    expect(buildConnectivityProbeArgs(target, 5)).toEqual([
      '-i', '/home/user/.ssh/id_build_c',
      '-p', '2222',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'ConnectTimeout=5',
      'deploy@192.168.1.102',
      'exit 0',
    ]);
  });

  it('defaults the probe port to 22', () => {
    const args = buildConnectivityProbeArgs({ host: 'h', user: 'u', sshKeyPath: '/k' });
    expect(args).toContain('-p');
    expect(args[args.indexOf('-p') + 1]).toBe('22');
  });
});

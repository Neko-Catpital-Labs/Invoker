import { describe, expect, it } from 'vitest';

import {
  addRemoteTarget,
  checkRemoteTargetConnectivity,
  type RemoteTargetConnectionSpec,
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

function makeConfig() {
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
        maxConcurrentTasksPerMember: 1,
      },
    },
  };
}

const newTarget: RemoteTargetInput = {
  id: 'build-server-b',
  host: '192.168.1.101',
  user: 'deploy',
  sshKeyPath: '/home/user/.ssh/id_build_b',
  port: 2222,
  maxConcurrentTasks: 2,
  provisionCommand: 'pnpm install --frozen-lockfile',
};

describe('addRemoteTarget', () => {
  it('appends the new target and leaves everything else byte-for-byte unchanged', () => {
    const config = makeConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(JSON.stringify(config)).toBe(before);

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

    const targets = result.config.remoteTargets as Record<string, unknown>;
    expect(JSON.stringify(targets['staging-server'])).toBe(JSON.stringify(stagingTarget));
    expect(result.config.executionPools).toBe(config.executionPools);
    expect(result.config.maxConcurrency).toBe(6);
    expect(result.config.defaultExecutionAgent).toBe('codex');
  });

  it('creates remoteTargets when the config has none', () => {
    const result = addRemoteTarget({ maxConcurrency: 2 }, newTarget);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config.remoteTargets as Record<string, unknown>)).toEqual(['build-server-b']);
    expect(result.config.maxConcurrency).toBe(2);
  });

  it('omits optional fields that were not provided', () => {
    const result = addRemoteTarget(
      {},
      { id: 'minimal', host: 'h', user: 'u', sshKeyPath: '/k' },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const targets = result.config.remoteTargets as Record<string, unknown>;
    expect(targets.minimal).toEqual({ host: 'h', user: 'u', sshKeyPath: '/k' });
  });

  it('rejects a target whose host already exists instead of adding a second entry', () => {
    const config = makeConfig();
    const before = JSON.stringify(config);

    const result = addRemoteTarget(config, { ...newTarget, id: 'staging-clone', host: '192.168.1.100' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-host');
    expect(result.error.conflictingTargetId).toBe('staging-server');
    expect(result.error.message).toContain('192.168.1.100');
    expect(JSON.stringify(config)).toBe(before);
  });

  it('rejects a target whose id already exists', () => {
    const result = addRemoteTarget(makeConfig(), { ...newTarget, id: 'staging-server' });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('duplicate-id');
    expect(result.error.conflictingTargetId).toBe('staging-server');
  });
});

describe('checkRemoteTargetConnectivity', () => {
  const spec: RemoteTargetConnectionSpec = {
    host: '192.168.1.101',
    user: 'deploy',
    sshKeyPath: '/home/user/.ssh/id_build_b',
    port: 2222,
  };

  it('uses the injected impl instead of running a real SSH probe', async () => {
    const calls: RemoteTargetConnectionSpec[] = [];
    const result = await checkRemoteTargetConnectivity(spec, {
      impl: (target) => {
        calls.push(target);
        return { reachable: true };
      },
    });

    expect(result).toEqual({ reachable: true });
    expect(calls).toEqual([spec]);
  });

  it('returns the injected impl failure outcome as-is', async () => {
    const result = await checkRemoteTargetConnectivity(spec, {
      impl: async () => ({ reachable: false, message: 'simulated auth failure' }),
    });

    expect(result).toEqual({ reachable: false, message: 'simulated auth failure' });
  });

  it('reports unreachable for a real probe against a closed local port', async () => {
    const result = await checkRemoteTargetConnectivity(
      { host: '127.0.0.1', user: 'nobody', sshKeyPath: '/nonexistent/key', port: 1 },
      { timeoutMs: 5000 },
    );

    expect(result.reachable).toBe(false);
    expect(result.message).toBeTruthy();
  });
});

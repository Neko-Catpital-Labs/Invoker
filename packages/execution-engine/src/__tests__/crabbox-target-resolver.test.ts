import { describe, it, expect } from 'vitest';
import {
  CrabboxTargetResolver,
  buildCrabboxWarmupArgs,
  buildCrabboxStatusArgs,
  buildCrabboxStopArgs,
  resolveCrabboxCleanupPolicy,
  shouldStopCrabboxLease,
  type CrabboxCommandResult,
  type CrabboxCommandRunner,
  type CrabboxResolverTargetConfig,
} from '../crabbox-target-resolver.js';

const baseConfig: CrabboxResolverTargetConfig = {
  id: 'crab1',
  crabboxCommand: '/usr/local/bin/crabbox',
  provider: 'fly',
  class: 'performance-4x',
  ttl: '30m',
  idleTimeout: '10m',
  network: 'invoker-net',
  target: 'us-east',
  stopAfter: 'completed',
  keepOnFailure: true,
  warmupArgs: ['--warm'],
  statusArgs: ['--region', 'iad'],
};

function ok(stdout: string): CrabboxCommandResult {
  return { stdout, stderr: '', exitCode: 0 };
}

const STATUS_JSON = JSON.stringify({
  id: 'lease-123',
  slug: 'happy-crab',
  provider: 'fly',
  status: 'ready',
  expiresAt: '2026-01-01T00:30:00.000Z',
  sshHost: '10.0.0.5',
  sshUser: 'invoker',
  sshPort: 2222,
  sshKey: '/home/me/.ssh/crabbox',
});

/** Records each invocation and replays scripted results in order. */
function scriptRunner(results: CrabboxCommandResult[]): {
  runner: CrabboxCommandRunner;
  calls: Array<{ command: string; args: readonly string[] }>;
} {
  const calls: Array<{ command: string; args: readonly string[] }> = [];
  let i = 0;
  const runner: CrabboxCommandRunner = async (command, args) => {
    calls.push({ command, args });
    const result = results[i];
    i += 1;
    return result;
  };
  return { runner, calls };
}

describe('buildCrabboxWarmupArgs', () => {
  it('builds warmup args from config plus explicit warmupArgs', () => {
    expect(buildCrabboxWarmupArgs(baseConfig)).toEqual([
      'warmup',
      '--provider',
      'fly',
      '--class',
      'performance-4x',
      '--ttl',
      '30m',
      '--idle-timeout',
      '10m',
      '--network',
      'invoker-net',
      '--target',
      'us-east',
      '--warm',
    ]);
  });
});

describe('buildCrabboxStatusArgs', () => {
  it('requests JSON status, waits, and appends explicit statusArgs', () => {
    expect(buildCrabboxStatusArgs(baseConfig, 'lease-123')).toEqual([
      'status',
      '--id',
      'lease-123',
      '--json',
      '--wait',
      '--region',
      'iad',
    ]);
  });
});

describe('CrabboxTargetResolver.resolve', () => {
  it('warms up, polls status, and returns an SSH target plus lease metadata', async () => {
    const { runner, calls } = scriptRunner([
      ok(JSON.stringify({ id: 'lease-123', slug: 'happy-crab' })),
      ok(STATUS_JSON),
    ]);
    const resolver = new CrabboxTargetResolver(runner);

    const result = await resolver.resolve(baseConfig);

    expect(calls[0]).toEqual({
      command: '/usr/local/bin/crabbox',
      args: buildCrabboxWarmupArgs(baseConfig),
    });
    expect(calls[1]).toEqual({
      command: '/usr/local/bin/crabbox',
      args: buildCrabboxStatusArgs(baseConfig, 'lease-123'),
    });

    expect(result.sshTarget).toEqual({
      host: '10.0.0.5',
      user: 'invoker',
      sshKeyPath: '/home/me/.ssh/crabbox',
      port: 2222,
    });
    expect(result.remoteLeaseMetadata).toEqual({
      provider: 'crabbox',
      leaseId: 'lease-123',
      slug: 'happy-crab',
      targetId: 'crab1',
      sshHost: '10.0.0.5',
      sshUser: 'invoker',
      sshPort: 2222,
      sshKeyPath: '/home/me/.ssh/crabbox',
      expiresAt: '2026-01-01T00:30:00.000Z',
      stopAfter: 'completed',
      keepOnFailure: true,
    });
  });

  it('accepts a plain id/slug printed by warmup', async () => {
    const { runner, calls } = scriptRunner([ok('lease-999\n'), ok(STATUS_JSON)]);
    const resolver = new CrabboxTargetResolver(runner);

    await resolver.resolve(baseConfig);

    expect(calls[1].args).toEqual(buildCrabboxStatusArgs(baseConfig, 'lease-999'));
  });

  it('falls back to the slug as lease ref when warmup omits id', async () => {
    const { runner, calls } = scriptRunner([
      ok(JSON.stringify({ slug: 'only-slug' })),
      ok(STATUS_JSON),
    ]);
    const resolver = new CrabboxTargetResolver(runner);

    await resolver.resolve(baseConfig);

    expect(calls[1].args).toEqual(buildCrabboxStatusArgs(baseConfig, 'only-slug'));
  });

  it('falls back to configured port when status omits sshPort', async () => {
    const status = JSON.stringify({
      id: 'lease-123',
      slug: 'happy-crab',
      sshHost: '10.0.0.5',
      sshUser: 'invoker',
      sshKey: '/home/me/.ssh/crabbox',
    });
    const { runner } = scriptRunner([ok('lease-123'), ok(status)]);

    const result = await new CrabboxTargetResolver(runner).resolve({
      ...baseConfig,
      port: 2200,
    });

    expect(result.sshTarget.port).toBe(2200);
    expect(result.remoteLeaseMetadata.sshPort).toBe(2200);
  });

  it('defaults to port 22 when neither status nor config supply a port', async () => {
    const status = JSON.stringify({
      id: 'lease-123',
      slug: 'happy-crab',
      sshHost: '10.0.0.5',
      sshUser: 'invoker',
      sshKey: '/home/me/.ssh/crabbox',
    });
    const { runner } = scriptRunner([ok('lease-123'), ok(status)]);

    const result = await new CrabboxTargetResolver(runner).resolve(baseConfig);

    expect(result.sshTarget.port).toBe(22);
  });

  it('rejects missing sshHost/sshUser/sshKey with an error naming the target id', async () => {
    const status = JSON.stringify({
      id: 'lease-123',
      slug: 'happy-crab',
      sshUser: 'invoker',
    });
    const { runner } = scriptRunner([ok('lease-123'), ok(status)]);

    await expect(
      new CrabboxTargetResolver(runner).resolve(baseConfig),
    ).rejects.toThrow(/crab1.*sshHost.*sshKey/s);
  });

  it('throws an actionable error when warmup exits non-zero', async () => {
    const { runner } = scriptRunner([
      { stdout: '', stderr: 'no capacity', exitCode: 1 },
    ]);

    await expect(
      new CrabboxTargetResolver(runner).resolve(baseConfig),
    ).rejects.toThrow(/Crabbox warmup failed for remote target "crab1".*no capacity/s);
  });

  it('throws an actionable error when status exits non-zero', async () => {
    const { runner } = scriptRunner([
      ok('lease-123'),
      { stdout: '', stderr: 'lease expired', exitCode: 2 },
    ]);

    await expect(
      new CrabboxTargetResolver(runner).resolve(baseConfig),
    ).rejects.toThrow(/Crabbox status failed for remote target "crab1".*lease expired/s);
  });

  it('throws when warmup returns no lease id or slug', async () => {
    const { runner } = scriptRunner([ok('   '), ok(STATUS_JSON)]);

    await expect(
      new CrabboxTargetResolver(runner).resolve(baseConfig),
    ).rejects.toThrow(/did not return a lease id or slug/);
  });

  it('throws when status output is not valid JSON', async () => {
    const { runner } = scriptRunner([ok('lease-123'), ok('not json')]);

    await expect(
      new CrabboxTargetResolver(runner).resolve(baseConfig),
    ).rejects.toThrow(/did not return valid JSON/);
  });
});

describe('CrabboxTargetResolver.refreshLease', () => {
  // Terminal restore re-inspects an already-leased machine by its persisted
  // lease id (no warmup, no --wait) and rebuilds the SSH endpoint. This is the
  // cross-surface read path that pairs with resolve()'s persisted metadata.

  const refreshConfig = {
    id: 'crab1',
    crabboxCommand: '/usr/local/bin/crabbox',
    statusArgs: ['--region', 'iad'],
    port: 2200,
  };

  it('runs a no-wait status call and returns the refreshed SSH endpoint', async () => {
    const { runner, calls } = scriptRunner([
      ok(
        JSON.stringify({
          id: 'lease-abc',
          slug: 'happy-crab',
          status: 'ready',
          sshHost: '198.51.100.7',
          sshUser: 'fresh-runner',
          sshPort: 2299,
          sshKey: '/leased/fresh-key',
        }),
      ),
    ]);

    const target = await new CrabboxTargetResolver(runner).refreshLease(
      refreshConfig,
      'lease-abc',
    );

    // Status call omits --wait so a dead/not-ready lease reports immediately.
    expect(calls[0]).toEqual({
      command: '/usr/local/bin/crabbox',
      args: ['status', '--id', 'lease-abc', '--json', '--region', 'iad'],
    });
    expect(target).toEqual({
      host: '198.51.100.7',
      user: 'fresh-runner',
      sshKeyPath: '/leased/fresh-key',
      port: 2299,
    });
  });

  it('falls back to the configured port when status omits sshPort', async () => {
    const { runner } = scriptRunner([
      ok(
        JSON.stringify({
          status: 'ready',
          sshHost: '198.51.100.7',
          sshUser: 'fresh-runner',
          sshKey: '/leased/fresh-key',
        }),
      ),
    ]);

    const target = await new CrabboxTargetResolver(runner).refreshLease(
      refreshConfig,
      'lease-abc',
    );

    expect(target.port).toBe(2200);
  });

  it('rejects an expired/stopped lease with an actionable error', async () => {
    const { runner } = scriptRunner([
      ok(JSON.stringify({ id: 'lease-abc', status: 'expired' })),
    ]);

    await expect(
      new CrabboxTargetResolver(runner).refreshLease(refreshConfig, 'lease-abc'),
    ).rejects.toThrow(/expired or been stopped/);
  });

  it('rejects when the status call exits non-zero (lease missing/unreachable)', async () => {
    const { runner } = scriptRunner([
      { stdout: '', stderr: 'lease not found', exitCode: 4 },
    ]);

    await expect(
      new CrabboxTargetResolver(runner).refreshLease(refreshConfig, 'lease-abc'),
    ).rejects.toThrow(/missing or unreachable.*lease not found/s);
  });
});

describe('buildCrabboxStopArgs', () => {
  it('builds `stop <leaseId>` plus configured stopArgs', () => {
    expect(
      buildCrabboxStopArgs(
        { id: 'crab1', crabboxCommand: 'crabbox', stopArgs: ['--force'] },
        'lease-123',
      ),
    ).toEqual(['stop', 'lease-123', '--force']);
  });

  it('omits stopArgs when none are configured', () => {
    expect(
      buildCrabboxStopArgs({ id: 'crab1', crabboxCommand: 'crabbox' }, 'lease-9'),
    ).toEqual(['stop', 'lease-9']);
  });
});

describe('CrabboxTargetResolver.stop', () => {
  it('runs `crabbox stop <leaseId>` with stopArgs and resolves on exit 0', async () => {
    const { runner, calls } = scriptRunner([ok('stopped')]);

    await new CrabboxTargetResolver(runner).stop(
      { id: 'crab1', crabboxCommand: '/usr/local/bin/crabbox', stopArgs: ['--now'] },
      'lease-123',
    );

    expect(calls[0]).toEqual({
      command: '/usr/local/bin/crabbox',
      args: ['stop', 'lease-123', '--now'],
    });
  });

  it('throws an actionable error when stop exits non-zero', async () => {
    const { runner } = scriptRunner([
      { stdout: '', stderr: 'lease not found', exitCode: 3 },
    ]);

    await expect(
      new CrabboxTargetResolver(runner).stop(
        { id: 'crab1', crabboxCommand: 'crabbox' },
        'lease-123',
      ),
    ).rejects.toThrow(/Crabbox stop failed for lease "lease-123".*crab1.*lease not found/s);
  });
});

describe('resolveCrabboxCleanupPolicy', () => {
  it('defaults stopAfter to success and keepOnFailure to true', () => {
    expect(resolveCrabboxCleanupPolicy(undefined, undefined)).toEqual({
      stopAfter: 'success',
      keepOnFailure: true,
    });
  });

  it('treats the legacy "completed" value as success', () => {
    expect(resolveCrabboxCleanupPolicy('completed', false)).toEqual({
      stopAfter: 'success',
      keepOnFailure: false,
    });
  });

  it('passes through known policies', () => {
    expect(resolveCrabboxCleanupPolicy('always', false).stopAfter).toBe('always');
    expect(resolveCrabboxCleanupPolicy('never', true).stopAfter).toBe('never');
    expect(resolveCrabboxCleanupPolicy('failure', false).stopAfter).toBe('failure');
  });
});

describe('shouldStopCrabboxLease', () => {
  it('success policy stops on success only', () => {
    const policy = { stopAfter: 'success' as const, keepOnFailure: false };
    expect(shouldStopCrabboxLease(policy, true)).toBe(true);
    expect(shouldStopCrabboxLease(policy, false)).toBe(false);
  });

  it('keepOnFailure preserves a failed lease regardless of stopAfter', () => {
    expect(
      shouldStopCrabboxLease({ stopAfter: 'always', keepOnFailure: true }, false),
    ).toBe(false);
    expect(
      shouldStopCrabboxLease({ stopAfter: 'success', keepOnFailure: true }, false),
    ).toBe(false);
  });

  it('always stops; never keeps', () => {
    expect(shouldStopCrabboxLease({ stopAfter: 'always', keepOnFailure: false }, false)).toBe(true);
    expect(shouldStopCrabboxLease({ stopAfter: 'never', keepOnFailure: false }, true)).toBe(false);
  });

  it('failure policy stops only on failure', () => {
    expect(shouldStopCrabboxLease({ stopAfter: 'failure', keepOnFailure: false }, false)).toBe(true);
    expect(shouldStopCrabboxLease({ stopAfter: 'failure', keepOnFailure: false }, true)).toBe(false);
  });
});

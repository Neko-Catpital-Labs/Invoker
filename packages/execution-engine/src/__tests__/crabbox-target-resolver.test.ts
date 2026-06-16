import { describe, it, expect } from 'vitest';
import {
  buildWarmupArgs,
  buildStatusArgs,
  resolveCrabboxTarget,
  type CommandRunner,
  type CommandRunnerResult,
  type CrabboxResolverConfig,
} from '../crabbox-target-resolver.js';

const baseConfig: CrabboxResolverConfig = {
  crabboxCommand: 'crabbox',
  provider: 'fly',
  class: 'performance-2x',
  ttl: '1h',
  idleTimeout: '20m',
  network: 'invoker-net',
  target: 'ubuntu-22.04',
  stopAfter: 'idle',
  keepOnFailure: true,
};

const ok = (stdout: string): CommandRunnerResult => ({ stdout, stderr: '', exitCode: 0 });

/**
 * Build a runner that records its invocations and returns canned output keyed
 * by the CLI subcommand (warmup/status).
 */
function recordingRunner(responses: {
  warmup?: CommandRunnerResult;
  status: CommandRunnerResult;
}): { runner: CommandRunner; calls: Array<{ command: string; args: string[] }> } {
  const calls: Array<{ command: string; args: string[] }> = [];
  const runner: CommandRunner = async (command, args) => {
    calls.push({ command, args: [...args] });
    const sub = args[0];
    if (sub === 'warmup') return responses.warmup ?? ok('');
    if (sub === 'status') return responses.status;
    throw new Error(`unexpected subcommand: ${sub}`);
  };
  return { runner, calls };
}

const FULL_STATUS = JSON.stringify({
  id: 'lease-123',
  slug: 'happy-otter',
  provider: 'fly',
  status: 'ready',
  expiresAt: '2026-06-16T12:00:00.000Z',
  sshHost: '10.0.0.5',
  sshUser: 'invoker',
  sshPort: 2222,
  sshKey: '/tmp/lease-key',
});

describe('buildWarmupArgs', () => {
  it('maps config fields to warmup flags and appends explicit warmupArgs', () => {
    const args = buildWarmupArgs({ ...baseConfig, warmupArgs: ['--warm', '--extra'] });
    expect(args).toEqual([
      'warmup',
      '--provider', 'fly',
      '--class', 'performance-2x',
      '--ttl', '1h',
      '--idle-timeout', '20m',
      '--network', 'invoker-net',
      '--target', 'ubuntu-22.04',
      '--warm', '--extra',
    ]);
  });

  it('stringifies numeric ttl and idleTimeout', () => {
    const args = buildWarmupArgs({ ...baseConfig, ttl: 3600, idleTimeout: 1200 });
    expect(args).toContain('3600');
    expect(args).toContain('1200');
  });
});

describe('buildStatusArgs', () => {
  it('requests JSON status with --wait for the given id plus explicit statusArgs', () => {
    const args = buildStatusArgs({ ...baseConfig, statusArgs: ['--timeout', '60'] }, 'lease-123');
    expect(args).toEqual([
      'status', '--id', 'lease-123', '--json', '--wait', '--timeout', '60',
    ]);
  });
});

describe('resolveCrabboxTarget', () => {
  it('warms up then queries status and returns a static SSH target plus lease metadata', async () => {
    const { runner, calls } = recordingRunner({ status: ok(FULL_STATUS) });
    const result = await resolveCrabboxTarget(baseConfig, runner);

    expect(calls[0]).toEqual({ command: 'crabbox', args: buildWarmupArgs(baseConfig) });
    expect(calls[1].args[0]).toBe('status');

    expect(result.target).toEqual({
      host: '10.0.0.5',
      user: 'invoker',
      sshKeyPath: '/tmp/lease-key',
      port: 2222,
    });
    expect(result.remoteLeaseMetadata).toEqual({
      provider: 'crabbox',
      leaseId: 'lease-123',
      slug: 'happy-otter',
      targetId: 'ubuntu-22.04',
      sshHost: '10.0.0.5',
      sshUser: 'invoker',
      sshPort: 2222,
      sshKeyPath: '/tmp/lease-key',
      expiresAt: '2026-06-16T12:00:00.000Z',
      stopAfter: 'idle',
      keepOnFailure: true,
    });
  });

  it('uses a lease id reported by warmup for the status lookup', async () => {
    const { runner, calls } = recordingRunner({
      warmup: ok(JSON.stringify({ id: 'warm-lease-9' })),
      status: ok(FULL_STATUS),
    });
    await resolveCrabboxTarget(baseConfig, runner);
    expect(calls[1].args).toEqual(['status', '--id', 'warm-lease-9', '--json', '--wait']);
  });

  it('falls back to the configured target id when warmup reports none', async () => {
    const { runner, calls } = recordingRunner({ warmup: ok('warming up...'), status: ok(FULL_STATUS) });
    await resolveCrabboxTarget(baseConfig, runner);
    expect(calls[1].args).toEqual(['status', '--id', 'ubuntu-22.04', '--json', '--wait']);
  });

  it('parses status JSON embedded among human-readable lines', async () => {
    const noisy = `waiting for box...\nbox is ready\n${FULL_STATUS}`;
    const { runner } = recordingRunner({ status: ok(noisy) });
    const result = await resolveCrabboxTarget(baseConfig, runner);
    expect(result.target.host).toBe('10.0.0.5');
  });

  it('coerces a string sshPort', async () => {
    const status = ok(JSON.stringify({
      id: 'l1', sshHost: 'h', sshUser: 'u', sshKey: '/k', sshPort: '2200',
    }));
    const { runner } = recordingRunner({ status });
    const result = await resolveCrabboxTarget(baseConfig, runner);
    expect(result.target.port).toBe(2200);
  });

  it('omits port when status reports none', async () => {
    const status = ok(JSON.stringify({ id: 'l1', sshHost: 'h', sshUser: 'u', sshKey: '/k' }));
    const { runner } = recordingRunner({ status });
    const result = await resolveCrabboxTarget(baseConfig, runner);
    expect(result.target.port).toBeUndefined();
    expect(result.remoteLeaseMetadata.sshPort).toBeUndefined();
  });

  it('throws naming the target id when sshHost is missing', async () => {
    const status = ok(JSON.stringify({ id: 'l1', sshUser: 'u', sshKey: '/k' }));
    const { runner } = recordingRunner({ status });
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(/ubuntu-22\.04/);
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(/sshHost/);
  });

  it('throws listing every missing SSH field', async () => {
    const status = ok(JSON.stringify({ id: 'l1' }));
    const { runner } = recordingRunner({ status });
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(
      /sshHost, sshUser, sshKey/,
    );
  });

  it('throws when warmup exits non-zero', async () => {
    const runner: CommandRunner = async (_cmd, args) =>
      args[0] === 'warmup'
        ? { stdout: '', stderr: 'no capacity', exitCode: 1 }
        : ok(FULL_STATUS);
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(/warmup failed.*no capacity/s);
  });

  it('throws when status exits non-zero', async () => {
    const { runner } = recordingRunner({ status: { stdout: '', stderr: 'lease gone', exitCode: 2 } });
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(/status failed.*lease gone/s);
  });

  it('throws when status output is not parseable JSON', async () => {
    const { runner } = recordingRunner({ status: ok('not json at all') });
    await expect(resolveCrabboxTarget(baseConfig, runner)).rejects.toThrow(/no parseable JSON/);
  });
});

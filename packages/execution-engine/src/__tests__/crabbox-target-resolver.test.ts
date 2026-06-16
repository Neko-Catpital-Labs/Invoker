import { describe, it, expect } from 'vitest';
import {
  buildWarmupArgs,
  buildStatusArgs,
  buildStopArgs,
  resolveCrabboxTarget,
  stopCrabboxLease,
  decideCrabboxCleanup,
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

describe('buildStopArgs', () => {
  it('builds a positional stop invocation for the lease id plus explicit stopArgs', () => {
    const args = buildStopArgs({ ...baseConfig, stopArgs: ['--force'] }, 'lease-123');
    expect(args).toEqual(['stop', 'lease-123', '--force']);
  });

  it('omits extra args when none are configured', () => {
    expect(buildStopArgs(baseConfig, 'lease-123')).toEqual(['stop', 'lease-123']);
  });
});

describe('stopCrabboxLease', () => {
  it('runs crabbox stop and resolves on exit 0', async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const runner: CommandRunner = async (command, args) => {
      calls.push({ command, args: [...args] });
      return ok('stopped');
    };
    await stopCrabboxLease({ ...baseConfig, stopArgs: ['--force'] }, 'lease-123', runner);
    expect(calls).toEqual([{ command: 'crabbox', args: ['stop', 'lease-123', '--force'] }]);
  });

  it('throws naming the lease id when stop exits non-zero', async () => {
    const runner: CommandRunner = async () => ({ stdout: '', stderr: 'no such lease', exitCode: 3 });
    await expect(stopCrabboxLease(baseConfig, 'lease-123', runner)).rejects.toThrow(
      /stop failed for lease "lease-123".*no such lease/s,
    );
  });
});

describe('decideCrabboxCleanup', () => {
  it('stops the box after a successful task under the default policy', () => {
    expect(decideCrabboxCleanup({ succeeded: true })).toEqual({ stop: true, keepForDebug: false });
  });

  it('keeps the box after a failed task when keepOnFailure defaults to true', () => {
    expect(decideCrabboxCleanup({ succeeded: false })).toEqual({ stop: false, keepForDebug: true });
  });

  it('stops a failed task when keepOnFailure is explicitly false', () => {
    expect(decideCrabboxCleanup({ succeeded: false, keepOnFailure: false })).toEqual({
      stop: true,
      keepForDebug: false,
    });
  });

  it('always stops the box regardless of outcome when stopAfter is always', () => {
    expect(decideCrabboxCleanup({ stopAfter: 'always', succeeded: false })).toEqual({
      stop: true,
      keepForDebug: false,
    });
    expect(decideCrabboxCleanup({ stopAfter: 'always', succeeded: true })).toEqual({
      stop: true,
      keepForDebug: false,
    });
  });

  it('never stops the box when stopAfter is never', () => {
    expect(decideCrabboxCleanup({ stopAfter: 'never', succeeded: true })).toEqual({
      stop: false,
      keepForDebug: false,
    });
    expect(decideCrabboxCleanup({ stopAfter: 'never', succeeded: false })).toEqual({
      stop: false,
      keepForDebug: true,
    });
  });

  it('treats an unknown idle policy as never (defer to Crabbox idle reaping)', () => {
    expect(decideCrabboxCleanup({ stopAfter: 'idle', succeeded: true })).toEqual({
      stop: false,
      keepForDebug: false,
    });
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

import { describe, expect, it, vi } from 'vitest';

import {
  buildRemoteDfScript,
  runDiskHeadroomCheck,
  type DiskHeadroomMonitorDeps,
  type RemoteDiskTarget,
} from '../workers/disk-headroom-monitor.js';

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => logger,
  };
  return logger;
}

/** `df -P -k` output for a filesystem at `pct`% used. */
function dfAt(pct: number): string {
  return `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 100 ${pct} ${100 - pct} ${pct}% /`;
}

const THRESHOLDS = { warnPercent: 85, criticalPercent: 95 };

function baseDeps(overrides: Partial<DiskHeadroomMonitorDeps>): DiskHeadroomMonitorDeps {
  return {
    logger: makeLogger() as any,
    thresholds: THRESHOLDS,
    localPath: '/tmp',
    remoteTargets: [],
    ...overrides,
  };
}

const CONN = { host: 'h', user: 'u', sshKeyPath: '/k' };

describe('runDiskHeadroomCheck — local disk', () => {
  it('warns (not errors) between the warn and critical thresholds', async () => {
    const deps = baseDeps({
      runLocalDf: async () => dfAt(90),
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results).toHaveLength(1);
    expect(results[0]?.level).toBe('warn');

    expect((deps.logger as any).warn).toHaveBeenCalled();
    expect((deps.logger as any).error).not.toHaveBeenCalled();
  });

  it('errors at/above the critical threshold', async () => {
    const deps = baseDeps({
      runLocalDf: async () => dfAt(95),
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results[0]?.level).toBe('critical');
    expect((deps.logger as any).error).toHaveBeenCalled();
  });

  it('stays quiet (debug only) below the warn threshold', async () => {
    const deps = baseDeps({
      runLocalDf: async () => dfAt(10),
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results[0]?.level).toBe('ok');
    expect((deps.logger as any).warn).not.toHaveBeenCalled();
    expect((deps.logger as any).error).not.toHaveBeenCalled();
    expect((deps.logger as any).debug).toHaveBeenCalled();
  });

  it('logs and swallows a df failure without throwing', async () => {
    const deps = baseDeps({
      runLocalDf: async () => {
        throw new Error('df down');
      },
    });

    await expect(runDiskHeadroomCheck(deps)).resolves.toEqual([]);
    expect((deps.logger as any).error).toHaveBeenCalled();
  });

  it('logs unparseable df output', async () => {
    const deps = baseDeps({
      runLocalDf: async () => 'garbage',
    });

    await expect(runDiskHeadroomCheck(deps)).resolves.toEqual([]);
    expect((deps.logger as any).error).toHaveBeenCalled();
  });

  it('never lets a wedged audit sink mask the alert', async () => {
    const deps = baseDeps({
      runLocalDf: async () => dfAt(95),
      writeActivityLog: () => {
        throw new Error('wedged');
      },
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results[0]?.level).toBe('critical');
    expect((deps.logger as any).error).toHaveBeenCalled();
  });
});

describe('runDiskHeadroomCheck — remote targets', () => {
  it('checks remotes in parallel and includes successful evaluations', async () => {
    const remoteTargets: RemoteDiskTarget[] = [
      { name: 'a', connection: CONN, remotePath: '~/.invoker' },
      { name: 'b', connection: CONN, remotePath: '~/.invoker' },
    ];

    const deps = baseDeps({
      remoteTargets,
      runLocalDf: async () => dfAt(10),
      runRemoteDf: async (t) => (t.name === 'a' ? dfAt(90) : dfAt(10)),
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results.map((r) => r.level).sort()).toEqual(['ok', 'ok', 'warn'].sort());
    expect((deps.logger as any).warn).toHaveBeenCalled();
  });

  it('logs and swallows a remote df failure', async () => {
    const deps = baseDeps({
      remoteTargets: [{ name: 'a', connection: CONN, remotePath: '~/.invoker' }],
      runLocalDf: async () => dfAt(10),
      runRemoteDf: async () => {
        throw new Error('remote down');
      },
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results).toHaveLength(1);
    expect((deps.logger as any).error).toHaveBeenCalled();
  });
});

describe('buildRemoteDfScript', () => {
  it('normalizes a leading tilde before running df', () => {
    const script = buildRemoteDfScript('~/.invoker');
    expect(script).toContain('WT=');
    expect(script).toContain('HOME');
    expect(script).toContain('df -P -k');
  });
});

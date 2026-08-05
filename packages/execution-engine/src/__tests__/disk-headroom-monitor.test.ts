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

  it('surfaces a df failure as an unknown-level evaluation instead of dropping it', async () => {
    const deps = baseDeps({
      runLocalDf: async () => {
        throw new Error('df down');
      },
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ label: 'local /tmp', level: 'unknown', error: 'df down' });
    expect((results[0] as any).usage).toBeUndefined();
    expect((deps.logger as any).error).toHaveBeenCalled();
  });

  it('surfaces unparseable df output as an unknown-level evaluation instead of dropping it', async () => {
    const deps = baseDeps({
      runLocalDf: async () => 'garbage',
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ label: 'local /tmp', level: 'unknown' });
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

  it('surfaces a remote df failure as unknown instead of dropping the target', async () => {
    const deps = baseDeps({
      remoteTargets: [{ name: 'a', connection: CONN, remotePath: '~/.invoker' }],
      runLocalDf: async () => dfAt(10),
      runRemoteDf: async () => {
        throw new Error('remote down');
      },
    });

    const results = await runDiskHeadroomCheck(deps);
    expect(results).toHaveLength(2);
    const remote = results.find((r) => r.label.startsWith('ssh:'));
    expect(remote).toMatchObject({ level: 'unknown', error: 'remote down' });
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

import { describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

import {
  DISK_HEADROOM_WORKER_KIND,
  registerDiskHeadroomWorker,
} from '../workers/disk-headroom-worker.js';
import type { DiskHeadroomMonitorDeps, RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';
import type { DiskHeadroomEvaluation } from '../workers/disk-headroom.js';

function makeLogger() {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  };

  logger.child.mockImplementation(() => logger as any);
  return logger as any;
}

function criticalEval(label: string): DiskHeadroomEvaluation {
  return {
    label,
    level: 'critical',
    usage: {
      filesystem: '/dev/vda1',
      blocks1024: 100,
      usedBlocks1024: 96,
      availableBlocks1024: 4,
      usedPercent: 96,
      mountedOn: '/',
    },
    thresholds: { warnPercent: 85, criticalPercent: 95 },
  };
}

function warnEval(label: string): DiskHeadroomEvaluation {
  return {
    ...criticalEval(label),
    level: 'warn',
    usage: { ...criticalEval(label).usage, usedPercent: 90, usedBlocks1024: 90, availableBlocks1024: 10 },
  };
}

describe('disk-headroom worker', () => {
  it('registers and runs a disk check on tick', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerDiskHeadroomWorker(registry);

    const runCheck = vi.fn(async (_deps: DiskHeadroomMonitorDeps) => []);

    const logger = makeLogger();
    const remoteTargets: RemoteDiskTarget[] = [
      {
        name: 'remote-1',
        connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
        remotePath: '~/.invoker',
      },
    ];

    const definition = registry.get(DISK_HEADROOM_WORKER_KIND);
    expect(definition).toBeTruthy();

    const deps = {
      store: {} as any,
      submitter: { submit: vi.fn() } as any,
      logger,
      diskHeadroom: {
        localPath: '/tmp/invoker',
        remoteTargets,
        thresholds: { warnPercent: 85, criticalPercent: 95 },
        intervalMs: 0,
        tickOnStart: false,
        runCheck,
      },
    } satisfies WorkerRuntimeDependencies;

    const runtime = definition!.factory(deps);
    await runtime.tick('manual');

    expect(runCheck).toHaveBeenCalledTimes(1);
    expect(runCheck.mock.calls[0]?.[0]).toMatchObject({
      logger,
      localPath: '/tmp/invoker',
      remoteTargets,
      thresholds: { warnPercent: 85, criticalPercent: 95 },
    });
  });

  it('cleans critical targets and skips warn-only targets', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerDiskHeadroomWorker(registry);

    const remoteTargets: RemoteDiskTarget[] = [
      {
        name: 'remote-1',
        connection: { host: 'h', user: 'u', sshKeyPath: '/k' },
        remotePath: '~/.invoker',
      },
    ];
    const localLabel = 'local /tmp/invoker-home';
    const remoteLabel = 'ssh:remote-1 ~/.invoker';

    const runCheck = vi.fn(async () => [
      warnEval('local /tmp/other'),
      criticalEval(localLabel),
      criticalEval(remoteLabel),
    ]);
    const cleanupLocal = vi.fn(async () => ({
      targetKey: localLabel,
      ok: true,
      reason: 'critical-cleanup',
    }));
    const cleanupRemote = vi.fn(async () => ({
      targetKey: remoteLabel,
      ok: true,
      reason: 'critical-cleanup',
    }));
    const upsertWorkerAction = vi.fn((row: unknown) => row);

    const definition = registry.get(DISK_HEADROOM_WORKER_KIND)!;
    const runtime = definition.factory({
      store: { upsertWorkerAction } as any,
      submitter: { submit: vi.fn() } as any,
      logger: makeLogger(),
      diskHeadroom: {
        localPath: '/tmp/invoker-home',
        remoteTargets,
        thresholds: { warnPercent: 85, criticalPercent: 95 },
        intervalMs: 0,
        tickOnStart: false,
        cleanupCooldownMs: 60_000,
        runCheck,
        cleanupLocal,
        cleanupRemote,
      },
    });

    await runtime.tick('manual');

    expect(cleanupLocal).toHaveBeenCalledTimes(1);
    expect(cleanupLocal.mock.calls[0]?.[0]).toMatchObject({
      invokerHome: '/tmp/invoker-home',
      targetKey: localLabel,
    });
    expect(cleanupRemote).toHaveBeenCalledTimes(1);
    expect(cleanupRemote.mock.calls[0]?.[0]).toMatchObject({
      target: remoteTargets[0],
    });
    expect(upsertWorkerAction).toHaveBeenCalled();
  });

  it('respects cleanup cooldown on a second critical tick', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerDiskHeadroomWorker(registry);

    const localLabel = 'local /tmp/invoker-home';
    const runCheck = vi.fn(async () => [criticalEval(localLabel)]);
    const cleanupLocal = vi.fn(async () => ({
      targetKey: localLabel,
      ok: true,
      reason: 'critical-cleanup',
    }));

    const definition = registry.get(DISK_HEADROOM_WORKER_KIND)!;
    const runtime = definition.factory({
      store: {} as any,
      submitter: { submit: vi.fn() } as any,
      logger: makeLogger(),
      diskHeadroom: {
        localPath: '/tmp/invoker-home',
        remoteTargets: [],
        intervalMs: 0,
        tickOnStart: false,
        cleanupCooldownMs: 60_000,
        runCheck,
        cleanupLocal,
      },
    });

    await runtime.tick('manual');
    await runtime.tick('manual');

    expect(cleanupLocal).toHaveBeenCalledTimes(1);
  });

  it('does not clean when cleanup is disabled', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerDiskHeadroomWorker(registry);

    const cleanupLocal = vi.fn();
    const definition = registry.get(DISK_HEADROOM_WORKER_KIND)!;
    const runtime = definition.factory({
      store: {} as any,
      submitter: { submit: vi.fn() } as any,
      logger: makeLogger(),
      diskHeadroom: {
        localPath: '/tmp/invoker-home',
        remoteTargets: [],
        intervalMs: 0,
        tickOnStart: false,
        cleanupEnabled: false,
        runCheck: async () => [criticalEval('local /tmp/invoker-home')],
        cleanupLocal,
      },
    });

    await runtime.tick('manual');
    expect(cleanupLocal).not.toHaveBeenCalled();
  });
});

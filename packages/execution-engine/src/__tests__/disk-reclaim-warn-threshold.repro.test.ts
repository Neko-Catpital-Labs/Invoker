import { describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntime } from '../worker-runtime.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

import {
  DISK_HEADROOM_WORKER_KIND,
  registerDiskHeadroomWorker,
} from '../workers/disk-headroom-worker.js';
import {
  runDiskHeadroomCheck,
  type DiskHeadroomMonitorDeps,
} from '../workers/disk-headroom-monitor.js';

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

/** `df -P -k` output for a filesystem at `pct`% used. */
function dfAt(pct: number): string {
  return `Filesystem 1024-blocks Used Available Capacity Mounted on
/dev/vda1 100 ${pct} ${100 - pct} ${pct}% /`;
}

function makeRuntime(usedPercents: number[]): {
  cleanupLocal: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
  runtime: WorkerRuntime;
} {
  const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
  registerDiskHeadroomWorker(registry);

  let dfCall = 0;
  const runLocalDf = vi.fn(async () => {
    const fallback = usedPercents[usedPercents.length - 1] ?? 0;
    const pct = usedPercents[dfCall] ?? fallback;
    dfCall += 1;
    return dfAt(pct);
  });
  const runCheck = vi.fn(async (deps: DiskHeadroomMonitorDeps) => (
    runDiskHeadroomCheck({ ...deps, runLocalDf })
  ));
  const cleanupLocal = vi.fn(async ({ targetKey }: { targetKey: string }) => ({
    targetKey,
    ok: true,
    reason: 'critical-cleanup' as const,
  }));

  const definition = registry.get(DISK_HEADROOM_WORKER_KIND)!;
  const logger = makeLogger();
  const runtime = definition.factory({
    store: {} as any,
    submitter: { submit: vi.fn() } as any,
    logger,
    diskHeadroom: {
      localPath: '/tmp/invoker-home',
      remoteTargets: [],
      thresholds: { warnPercent: 85, criticalPercent: 95 },
      intervalMs: 0,
      tickOnStart: false,
      cleanupCooldownMs: 0,
      runCheck,
      cleanupLocal,
    },
  });

  return { cleanupLocal, logger, runtime };
}

describe('disk reclaim warn-threshold repro', () => {
  it('does not reclaim at 94% warn pressure, then reclaims at 95% critical pressure', async () => {
    const { cleanupLocal, logger, runtime } = makeRuntime([94, 95]);

    await runtime.tick('manual');
    expect(cleanupLocal).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      '[disk-headroom] warn: local /tmp/invoker-home (94% used)',
      expect.objectContaining({
        module: 'disk-headroom',
        label: 'local /tmp/invoker-home',
        usedPercent: 94,
        warnPercent: 85,
        criticalPercent: 95,
      }),
    );

    await runtime.tick('manual');
    expect(cleanupLocal).toHaveBeenCalledTimes(1);
    expect(cleanupLocal.mock.calls[0]?.[0]).toMatchObject({
      invokerHome: '/tmp/invoker-home',
      targetKey: 'local /tmp/invoker-home',
    });
  });

  it('reclaims after repeated 94% warn pressure with paced reclaim', async () => {
    const { cleanupLocal, runtime } = makeRuntime([94, 94]);

    await runtime.tick('manual');
    await runtime.tick('manual');

    expect(cleanupLocal).toHaveBeenCalledTimes(1);
    expect(cleanupLocal.mock.calls[0]?.[0]).toMatchObject({
      mode: 'stale-only',
    });
  });
});

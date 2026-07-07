import { describe, expect, it, vi } from 'vitest';

import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

import {
  DISK_HEADROOM_WORKER_KIND,
  registerDiskHeadroomWorker,
} from '../workers/disk-headroom-worker.js';
import type { DiskHeadroomMonitorDeps, RemoteDiskTarget } from '../workers/disk-headroom-monitor.js';

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
});

import { describe, expect, it, vi } from 'vitest';

import { registerBuiltinWorkers } from '../builtin-workers.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

import type { DiskCleanupResult } from '../workers/disk-headroom-reclaim.js';
import {
  createReaperWorker,
  REAPER_WORKER_KIND,
  registerReaperWorker,
} from '../workers/reaper-worker.js';

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

function okResult(targetKey: string): DiskCleanupResult {
  return { targetKey, ok: true, reason: 'reap-orphans', detail: 'removed 1' };
}

describe('reaper worker', () => {
  it('is registered among the built-in workers and builds a runtime from dependencies', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerBuiltinWorkers(registry);

    const definition = registry.get(REAPER_WORKER_KIND);
    expect(definition).toBeTruthy();

    const runtime = definition!.factory({
      store: {} as any,
      submitter: { submit: vi.fn() } as any,
      logger: makeLogger(),
      diskHeadroom: { localPath: '/tmp/invoker-home', remoteTargets: [] },
    } satisfies WorkerRuntimeDependencies);
    expect(runtime.identity.kind).toBe(REAPER_WORKER_KIND);
  });

  it('calls each of the four checks once per tick and writes one record-keeping entry', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerReaperWorker(registry);
    expect(registry.get(REAPER_WORKER_KIND)).toBeTruthy();

    const reapOrphans = vi.fn(async () => [okResult('local /tmp/invoker-home')]);
    const reapCheckouts = vi.fn(() => ['/tmp/invoker-home/mergify-admin-requeue-work/old-item']);
    const enforceRetention = vi.fn(() => 2);
    const trimLogs = vi.fn(() => ['/tmp/invoker-home/invoker.log']);
    const upsertWorkerAction = vi.fn((row: any) => row);

    const runtime = createReaperWorker({
      logger: makeLogger(),
      invokerHome: '/tmp/invoker-home',
      remoteTargets: [],
      intervalMs: 0,
      tickOnStart: false,
      store: { upsertWorkerAction },
      reapOrphans,
      reapCheckouts,
      enforceRetention,
      trimLogs,
    });

    await runtime.tick('manual');

    expect(reapOrphans).toHaveBeenCalledTimes(1);
    expect(reapOrphans.mock.calls[0]?.[0]).toMatchObject({
      invokerHome: '/tmp/invoker-home',
      remoteTargets: [],
    });
    expect(reapCheckouts).toHaveBeenCalledTimes(1);
    expect(reapCheckouts.mock.calls[0]?.[0]).toMatchObject({ invokerHome: '/tmp/invoker-home' });
    expect(enforceRetention).toHaveBeenCalledTimes(1);
    expect(enforceRetention.mock.calls[0]?.[0]).toBe('/tmp/invoker-home');
    expect(trimLogs).toHaveBeenCalledTimes(1);
    expect(trimLogs.mock.calls[0]?.[0]).toMatchObject({ invokerHome: '/tmp/invoker-home' });

    expect(upsertWorkerAction).toHaveBeenCalledTimes(1);
    expect(upsertWorkerAction.mock.calls[0]?.[0]).toMatchObject({
      workerKind: REAPER_WORKER_KIND,
      actionType: 'reaper-pass',
      externalKey: 'pass',
      subjectType: 'invoker-home',
      subjectId: '/tmp/invoker-home',
      status: 'completed',
      attemptCount: 1,
    });
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('checkouts removed 1');
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('snapshots pruned 2');
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('logs trimmed 1');
  });

  it('records a failed pass when an orphan target fails', async () => {
    const failedResult: DiskCleanupResult = {
      targetKey: 'ssh:remote-1 ~/.invoker',
      ok: false,
      reason: 'cleanup-error',
      detail: 'ssh timed out',
    };
    const upsertWorkerAction = vi.fn((row: any) => row);

    const runtime = createReaperWorker({
      logger: makeLogger(),
      invokerHome: '/tmp/invoker-home',
      intervalMs: 0,
      tickOnStart: false,
      store: { upsertWorkerAction },
      reapOrphans: vi.fn(async () => [okResult('local /tmp/invoker-home'), failedResult]),
      reapCheckouts: vi.fn(() => []),
      enforceRetention: vi.fn(() => 0),
      trimLogs: vi.fn(() => []),
    });

    await runtime.tick('manual');

    expect(upsertWorkerAction).toHaveBeenCalledTimes(1);
    expect(upsertWorkerAction.mock.calls[0]?.[0]).toMatchObject({
      workerKind: REAPER_WORKER_KIND,
      status: 'failed',
    });
    expect(upsertWorkerAction.mock.calls[0]?.[0].payload).toMatchObject({
      reason: 'cleanup-error',
    });
  });
});

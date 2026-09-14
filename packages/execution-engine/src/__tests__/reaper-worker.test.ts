import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  return {
    targetKey,
    ok: true,
    reason: 'reap-orphans',
    detail: 'removed 1',
    protectedSkipCount: 0,
    protectedSkipBytes: 0,
  };
}

describe('reaper worker log files', () => {
  it('leaves an oversized invoker.log at its full size after a pass', async () => {
    const root = mkdtempSync(join(tmpdir(), 'invoker-reaper-logs-'));
    try {
      const home = join(root, '.invoker');
      mkdirSync(home, { recursive: true });
      const logPath = join(home, 'invoker.log');
      writeFileSync(logPath, '');
      const size = 101 * 1024 * 1024;
      truncateSync(logPath, size);

      const runtime = createReaperWorker({
        logger: makeLogger(),
        invokerHome: home,
        intervalMs: 0,
        tickOnStart: false,
        reapOrphans: vi.fn(async () => []),
        reapCheckouts: vi.fn(() => []),
        reapWorktrees: vi.fn(async () => []),
        reapTempDirs: vi.fn(async () => []),
        enforceRetention: vi.fn(() => 0),
      });
      await runtime.tick('manual');

      expect(statSync(logPath).size).toBe(size);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

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

  it('calls each cleanup once per tick and writes one record-keeping entry', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerReaperWorker(registry);
    expect(registry.get(REAPER_WORKER_KIND)).toBeTruthy();

    const remoteTargets = [
      { name: 'remote-1', connection: { host: 'h', user: 'u', sshKeyPath: '/k' }, remotePath: '~/.invoker' },
    ];
    const reapOrphans = vi.fn(async () => [okResult('local /tmp/invoker-home')]);
    const reapCheckouts = vi.fn(() => ['/tmp/invoker-home/mergify-admin-requeue-work/old-item']);
    const reapWorktrees = vi.fn(async () => [
      { ...okResult('local /tmp/invoker-home'), reason: 'reap-worktrees', detail: 'removed 2' },
      { ...okResult('ssh:remote-1 ~/.invoker'), reason: 'reap-worktrees', detail: 'removed 3' },
    ]);
    const reapTempDirs = vi.fn(async () => ['/tmp/invoker-cli-prompt-old']);
    const enforceRetention = vi.fn(() => 2);
    const reapMergeClones = vi.fn(async () => ({
      ok: true,
      removed: ['/tmp/invoker-home/merge-clones/gate-a', '/tmp/invoker-home/merge-clones/gate-b'],
    }));
    const reapDevHomes = vi.fn(async () => ({
      ok: true,
      removed: ['/tmp/invoker-home/dev/aaaa000001'],
      unchecked: ['/tmp/invoker-home/dev/bbbb000002'],
    }));
    const taskStore = { listWorkflows: () => [], loadTasks: () => [] };
    const upsertWorkerAction = vi.fn((row: any) => row);

    const runtime = createReaperWorker({
      logger: makeLogger(),
      invokerHome: '/tmp/invoker-home',
      remoteTargets,
      intervalMs: 0,
      tickOnStart: false,
      store: { upsertWorkerAction },
      taskStore,
      reapOrphans,
      reapCheckouts,
      reapWorktrees,
      reapTempDirs,
      enforceRetention,
      reapMergeClones,
      reapDevHomes,
    });

    await runtime.tick('manual');

    expect(reapOrphans).toHaveBeenCalledTimes(1);
    expect(reapOrphans.mock.calls[0]?.[0]).toMatchObject({
      invokerHome: '/tmp/invoker-home',
      remoteTargets,
    });
    expect(reapCheckouts).toHaveBeenCalledTimes(1);
    expect(reapCheckouts.mock.calls[0]?.[0]).toMatchObject({ invokerHome: '/tmp/invoker-home' });
    expect(reapTempDirs).toHaveBeenCalledTimes(1);
    expect(reapTempDirs.mock.calls[0]?.[0]).toMatchObject({ tempRoot: expect.any(String) });
    expect(enforceRetention).toHaveBeenCalledTimes(1);
    expect(enforceRetention.mock.calls[0]?.[0]).toBe('/tmp/invoker-home');
    expect(reapWorktrees).toHaveBeenCalledTimes(1);
    expect(reapWorktrees.mock.calls[0]?.[0]).toMatchObject({
      invokerHome: '/tmp/invoker-home',
      remoteTargets,
    });

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
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('CLI temp dirs removed 1');
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('snapshots pruned 2');
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('worktrees removed 5');
    expect(reapMergeClones).toHaveBeenCalledTimes(1);
    expect(reapMergeClones.mock.calls[0]?.[0]).toMatchObject({ invokerHome: '/tmp/invoker-home', taskStore });
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('merge clones removed 2');
    expect(reapDevHomes).toHaveBeenCalledTimes(1);
    expect(reapDevHomes.mock.calls[0]?.[0]).toMatchObject({ invokerHome: '/tmp/invoker-home' });
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('dev homes removed 1, dev homes unchecked 1');
    expect(upsertWorkerAction.mock.calls[0]?.[0].payload).toMatchObject({
      tempDirsRemoved: ['/tmp/invoker-cli-prompt-old'],
      worktreesRemoved: 5,
      worktreeResults: [
        { targetKey: 'local /tmp/invoker-home', reason: 'reap-worktrees', detail: 'removed 2' },
        { targetKey: 'ssh:remote-1 ~/.invoker', reason: 'reap-worktrees', detail: 'removed 3' },
      ],
    });
  });

  it('records a failed pass when an orphan target fails', async () => {
    const failedResult: DiskCleanupResult = {
      targetKey: 'ssh:remote-1 ~/.invoker',
      ok: false,
      reason: 'cleanup-error',
      detail: 'ssh timed out',
      protectedSkipCount: 0,
      protectedSkipBytes: 0,
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
      reapWorktrees: vi.fn(async () => []),
      reapTempDirs: vi.fn(async () => []),
      enforceRetention: vi.fn(() => 0),
      reapMergeClones: vi.fn(async () => ({ ok: true, removed: [] })),
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

  it('records a failed pass when merge clones are skipped because task state is unreadable', async () => {
    const upsertWorkerAction = vi.fn((row: any) => row);

    const runtime = createReaperWorker({
      logger: makeLogger(),
      invokerHome: '/tmp/invoker-home',
      intervalMs: 0,
      tickOnStart: false,
      store: { upsertWorkerAction },
      reapOrphans: vi.fn(async () => [okResult('local /tmp/invoker-home')]),
      reapCheckouts: vi.fn(() => []),
      reapWorktrees: vi.fn(async () => []),
      reapTempDirs: vi.fn(async () => []),
      enforceRetention: vi.fn(() => 0),
      reapMergeClones: vi.fn(async () => ({ ok: false, removed: [], reason: 'no-task-store' })),
    });

    await runtime.tick('manual');

    expect(upsertWorkerAction.mock.calls[0]?.[0]).toMatchObject({
      workerKind: REAPER_WORKER_KIND,
      status: 'failed',
    });
    expect(upsertWorkerAction.mock.calls[0]?.[0].payload).toMatchObject({ reason: 'no-task-store' });
    expect(upsertWorkerAction.mock.calls[0]?.[0].summary).toContain('merge clone reap failed: no-task-store');
  });
});

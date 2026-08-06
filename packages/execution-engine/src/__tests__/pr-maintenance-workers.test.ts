import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';
import type { WorkerActionRecord, WorkerActionWrite } from '@invoker/data-store';

import { SIGKILL_TIMEOUT_MS } from '../process-utils.js';
import {
  DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
  PR_ADMIN_BYPASS_LAND_WORKER_KIND,
  PR_DUPLICATE_CLOSE_WORKER_KIND,
  PR_MAINTENANCE_WORKER_STAGGER_STEP_MS,
  PR_ORPHAN_REPAIR_WORKER_KIND,
  createPrAdminBypassLandWorker,
  createPrDuplicateCloseWorker,
  createPrOrphanRepairWorker,
  type PrMaintenanceLockProbeOptions,
} from '../workers/pr-maintenance-workers.js';

type SpawnCall = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

function makeLogger(): Logger & {
  info: ReturnType<typeof vi.fn>;
  warn: ReturnType<typeof vi.fn>;
  error: ReturnType<typeof vi.fn>;
  debug: ReturnType<typeof vi.fn>;
} {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return logger;
}

function makeSpawnHarness(options: {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
} = {}): { calls: SpawnCall[]; spawnProcess: typeof spawn } {
  const calls: SpawnCall[] = [];
  const spawnProcess = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: null,
      killed: false,
      pid: 12345,
      kill: vi.fn(),
    }) as unknown as ChildProcess;

    queueMicrotask(() => {
      stdout.end(options.stdout ?? '');
      stderr.end(options.stderr ?? '');
      child.emit('close', options.exitCode ?? 0, null);
    });

    return child;
  });

  return { calls, spawnProcess: spawnProcess as unknown as typeof spawn };
}

function makeHungSpawnHarness(options: {
  cooperativeKill?: boolean;
} = {}): { calls: SpawnCall[]; spawnProcess: typeof spawn } {
  const calls: SpawnCall[] = [];
  const spawnProcess = vi.fn((command: string, args: string[], spawnOptions: SpawnOptions) => {
    calls.push({ command, args, options: spawnOptions });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin: null,
      killed: false,
      pid: 12345,
      // Never emits 'close' or 'error' on its own — simulates a wedged
      // child (e.g. blocked on a dead owner's IPC handshake).
      kill: vi.fn(() => {
        if (options.cooperativeKill) {
          queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
        }
        return true;
      }),
    }) as unknown as ChildProcess;
    return child;
  });

  return { calls, spawnProcess: spawnProcess as unknown as typeof spawn };
}

describe('PR maintenance workers', () => {
  let tmpRoot: string | undefined;

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    if (tmpRoot) {
      rmSync(tmpRoot, { recursive: true, force: true });
      tmpRoot = undefined;
    }
  });

  function makeRepoRoot(): string {
    tmpRoot = mkdtempSync(join(tmpdir(), 'invoker-pr-maintenance-test-'));
    return tmpRoot;
  }

  it('spawns the admin-bypass shell entrypoint with the configured cwd and env', async () => {
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness({ stdout: 'planned one PR\n', stderr: 'diagnostic line\n' });
    const lockProbe = vi.fn((_options: PrMaintenanceLockProbeOptions) => ({ held: false }));
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      env: {
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
      },
      lockPath,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe,
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(lockProbe).toHaveBeenCalledWith(expect.objectContaining({
      lockPath,
      env: expect.objectContaining({
        INVOKER_REPO_ROOT: repoRoot,
        INVOKER_PR_CRON_LOCK: lockPath,
        INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
        INVOKER_PR_CRON_AUTHOR: 'octocat',
      }),
    }));
    expect(spawnHarness.calls).toEqual([
      expect.objectContaining({
        command: 'bash',
        args: [resolve(repoRoot, 'scripts/cron-pr-admin-bypass-land.sh')],
        options: expect.objectContaining({
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: expect.objectContaining({
            INVOKER_REPO_ROOT: repoRoot,
            INVOKER_PR_CRON_LOCK: lockPath,
            INVOKER_GITHUB_TARGET_REPO: 'owner/repo',
            INVOKER_PR_CRON_AUTHOR: 'octocat',
          }),
        }),
      }),
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_ADMIN_BYPASS_LAND_WORKER_KIND}] planned one PR`,
      expect.objectContaining({ stream: 'stdout' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[worker:${PR_ADMIN_BYPASS_LAND_WORKER_KIND}] diagnostic line`,
      expect.objectContaining({ stream: 'stderr' }),
    );
  });

  it('spawns the orphan-repair shell entrypoint', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrOrphanRepairWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(spawnHarness.calls[0]).toEqual(expect.objectContaining({
      command: 'bash',
      args: [resolve(repoRoot, 'scripts/cron-pr-orphan-repair.sh')],
      options: expect.objectContaining({ cwd: repoRoot }),
    }));
  });

  it('spawns the duplicate-close shell entrypoint', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrDuplicateCloseWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(spawnHarness.calls[0]).toEqual(expect.objectContaining({
      command: 'bash',
      args: [resolve(repoRoot, 'scripts/cron-pr-duplicate-close.sh')],
      options: expect.objectContaining({ cwd: repoRoot }),
    }));
  });

  it('staggers the duplicate-close worker 2/3 of the interval after the other two', async () => {
    vi.useFakeTimers();
    expect(PR_MAINTENANCE_WORKER_STAGGER_STEP_MS).toBe(DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS / 3);

    // createWorkerRuntime's beginPolling() sets an interval-cadence timer once
    // startDelayMs elapses, so the *first* tick lands at startDelayMs +
    // intervalMs, not at startDelayMs alone (verified against the existing
    // "polls on the five-minute default interval" case above, where
    // startDelayMs=0 and the first tick still lands at intervalMs).
    const repoRoot = makeRepoRoot();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrDuplicateCloseWorker({
      logger: makeLogger(),
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      startDelayMs: 2 * PR_MAINTENANCE_WORKER_STAGGER_STEP_MS,
    });

    worker.start();
    expect(spawnHarness.calls).toEqual([]);

    const firstTickAt = 2 * PR_MAINTENANCE_WORKER_STAGGER_STEP_MS + DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS;
    await vi.advanceTimersByTimeAsync(firstTickAt - 1);
    expect(spawnHarness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawnHarness.calls).toHaveLength(1);
    await worker.stop();
  });

  it('skips cleanly when the shared PR-maintenance lock is already held', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrOrphanRepairWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: true, reason: 'test-lock-held' }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(spawnHarness.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_ORPHAN_REPAIR_WORKER_KIND}] shared PR maintenance lock held; skipping tick`,
      expect.objectContaining({
        worker: PR_ORPHAN_REPAIR_WORKER_KIND,
        reason: 'test-lock-held',
      }),
    );
  });

  it('skips cleanly when the shared PR-maintenance lock is already held (duplicate-close)', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrDuplicateCloseWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: true, reason: 'test-lock-held' }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(spawnHarness.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${PR_DUPLICATE_CLOSE_WORKER_KIND}] shared PR maintenance lock held; skipping tick`,
      expect.objectContaining({
        worker: PR_DUPLICATE_CLOSE_WORKER_KIND,
        reason: 'test-lock-held',
      }),
    );
  });

  it('records running and completed decision rows for a successful run', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness({ exitCode: 0 });
    const actions = new Map<string, WorkerActionRecord>();
    const store = {
      getWorkerAction: vi.fn((kind: string, key: string) => actions.get(`${kind}:${key}`)),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => {
        const mapKey = `${write.workerKind}:${write.externalKey}`;
        const existing = actions.get(mapKey);
        const saved = {
          ...write,
          attemptCount: write.attemptCount ?? 0,
          id: existing?.id ?? write.id,
          createdAt: existing?.createdAt ?? 'now',
          updatedAt: 'now',
        } as WorkerActionRecord;
        actions.set(mapKey, saved);
        return saved;
      }),
    };
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      store,
    });

    await worker.tick();

    const statuses = store.upsertWorkerAction.mock.calls.map((call) => call[0].status);
    expect(statuses).toEqual(['running', 'completed']);
    expect(store.upsertWorkerAction.mock.calls[0]?.[0]).toMatchObject({
      workerKind: PR_ADMIN_BYPASS_LAND_WORKER_KIND,
      actionType: 'pr-maintenance-run',
      subjectType: 'repo',
      subjectId: repoRoot,
    });
  });

  it('does not record a decision row when the lock is held', async () => {
    const repoRoot = makeRepoRoot();
    const store = {
      getWorkerAction: vi.fn(() => undefined),
      upsertWorkerAction: vi.fn(),
    };
    const worker = createPrOrphanRepairWorker({
      logger: makeLogger(),
      repoRoot,
      spawnProcess: makeSpawnHarness().spawnProcess,
      lockProbe: () => ({ held: true, reason: 'lock-held' }),
      installSignalHandlers: false,
      store,
    });

    await worker.tick();

    expect(store.upsertWorkerAction).not.toHaveBeenCalled();
  });

  it('polls on the five-minute default interval without ticking on start', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
    });

    worker.start();
    expect(spawnHarness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS - 1);
    expect(spawnHarness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(spawnHarness.calls).toHaveLength(1);
    await worker.stop();
  });

  it('reproduces the pre-fix hang: a hung child with the tick timeout disabled wedges the scheduler forever', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeHungSpawnHarness();
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      tickTimeoutMs: 0,
      intervalMs: 60_000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(60_000 * 5);

    expect(spawnHarness.calls).toHaveLength(1);
    await worker.stop({ settleTimeoutMs: 0 });
  });

  it('kills a hung child after the tick timeout and lets the next scheduled tick proceed', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeHungSpawnHarness();
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      tickTimeoutMs: 1_000,
      intervalMs: 10_000,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(10_000 + 999);
    expect(spawnHarness.calls).toHaveLength(1);
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('killing spawned child'),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(1);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('killing spawned child'),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(SIGKILL_TIMEOUT_MS + 1_000);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('force-abandoning'),
      expect.anything(),
    );

    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnHarness.calls).toHaveLength(2);

    await worker.stop({ settleTimeoutMs: 0 });
  });

  it('fails the tick as tick-timeout (not force-abandoned) when the child cooperates with SIGTERM/SIGKILL, and pins detached:true on the spawn call', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeHungSpawnHarness({ cooperativeKill: true });
    const store = {
      getWorkerAction: vi.fn(() => undefined),
      upsertWorkerAction: vi.fn((write: WorkerActionWrite) => write as WorkerActionRecord),
    };
    const worker = createPrAdminBypassLandWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: false }),
      installSignalHandlers: false,
      tickTimeoutMs: 1_000,
      intervalMs: 10_000,
      store,
    });

    worker.start();
    await vi.advanceTimersByTimeAsync(10_000 + 1_000);

    const failedCall = store.upsertWorkerAction.mock.calls
      .map((call) => call[0] as WorkerActionWrite)
      .find((write) => write.status === 'failed');
    expect(failedCall?.payload).toMatchObject({ reason: 'tick-timeout' });
    expect(logger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('force-abandoning'),
      expect.anything(),
    );
    expect(spawnHarness.calls[0]?.options.detached).toBe(process.platform !== 'win32');

    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawnHarness.calls).toHaveLength(2);

    await worker.stop({ settleTimeoutMs: 0 });
  });
});

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

import {
  CODERABBIT_ADDRESS_WORKER_KIND,
  DEFAULT_PR_MAINTENANCE_WORKER_INTERVAL_MS,
  createCoderabbitAddressWorker,
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

  it('spawns the CodeRabbit shell entrypoint with the configured cwd and env', async () => {
    const repoRoot = makeRepoRoot();
    const lockPath = join(repoRoot, 'locks', 'pr-crons.lock');
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness({ stdout: 'addressed one PR\n', stderr: 'diagnostic line\n' });
    const lockProbe = vi.fn((_options: PrMaintenanceLockProbeOptions) => ({ held: false }));
    const worker = createCoderabbitAddressWorker({
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
        args: [resolve(repoRoot, 'scripts/cron-coderabbit-address.sh')],
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
      `[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] addressed one PR`,
      expect.objectContaining({ stream: 'stdout' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] diagnostic line`,
      expect.objectContaining({ stream: 'stderr' }),
    );
  });



  it('skips cleanly when the shared PR-maintenance lock is already held', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const spawnHarness = makeSpawnHarness();
    const worker = createCoderabbitAddressWorker({
      logger,
      repoRoot,
      spawnProcess: spawnHarness.spawnProcess,
      lockProbe: () => ({ held: true, reason: 'test-lock-held' }),
      installSignalHandlers: false,
    });

    await worker.tick();

    expect(spawnHarness.calls).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${CODERABBIT_ADDRESS_WORKER_KIND}] shared PR maintenance lock held; skipping tick`,
      expect.objectContaining({
        worker: CODERABBIT_ADDRESS_WORKER_KIND,
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
    const worker = createCoderabbitAddressWorker({
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
      workerKind: CODERABBIT_ADDRESS_WORKER_KIND,
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
    const worker = createCoderabbitAddressWorker({
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
    const worker = createCoderabbitAddressWorker({
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
});

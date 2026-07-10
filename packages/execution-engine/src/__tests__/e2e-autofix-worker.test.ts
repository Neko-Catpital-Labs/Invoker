import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';

import type { WorkerTickContext } from '../worker-runtime.js';
import {
  DEFAULT_E2E_AUTOFIX_INTERVAL_MS,
  E2E_AUTOFIX_SCRIPT_RELATIVE_PATH,
  E2E_AUTOFIX_WORKER_KIND,
  createE2eAutoFixTick,
  createE2eAutoFixWorker,
} from '../workers/e2e-autofix-worker.js';

type SpawnCall = {
  command: string;
  args: string[];
  options: SpawnOptions;
};

function makeLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger as unknown as Logger);
  return logger as unknown as Logger;
}

function makeCtx(): WorkerTickContext {
  return {
    identity: { kind: E2E_AUTOFIX_WORKER_KIND, instanceId: `${E2E_AUTOFIX_WORKER_KIND}-test` },
    reason: 'manual',
    tickNumber: 1,
    signal: new AbortController().signal,
  };
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
      pid: 4242,
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

describe('e2e auto-fix worker', () => {
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
    tmpRoot = mkdtempSync(join(tmpdir(), 'invoker-e2e-autofix-test-'));
    return tmpRoot;
  }

  it('spawns the daily-e2e-do-submit script with the repo root as cwd', async () => {
    const repoRoot = makeRepoRoot();
    const logger = makeLogger();
    const harness = makeSpawnHarness({ stdout: 'submitted one plan\n', stderr: 'diagnostic line\n' });

    const tick = createE2eAutoFixTick({
      logger,
      repoRoot,
      spawnProcess: harness.spawnProcess,
    });

    await tick(makeCtx());

    expect(harness.calls).toEqual([
      expect.objectContaining({
        command: 'bash',
        args: [resolve(repoRoot, E2E_AUTOFIX_SCRIPT_RELATIVE_PATH)],
        options: expect.objectContaining({
          cwd: repoRoot,
          stdio: ['ignore', 'pipe', 'pipe'],
        }),
      }),
    ]);
    expect(logger.info).toHaveBeenCalledWith(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] submitted one plan`,
      expect.objectContaining({ stream: 'stdout' }),
    );
    expect(logger.warn).toHaveBeenCalledWith(
      `[worker:${E2E_AUTOFIX_WORKER_KIND}] diagnostic line`,
      expect.objectContaining({ stream: 'stderr' }),
    );
  });

  it('resolves when the script exits with code 0', async () => {
    const repoRoot = makeRepoRoot();
    const tick = createE2eAutoFixTick({
      logger: makeLogger(),
      repoRoot,
      spawnProcess: makeSpawnHarness({ exitCode: 0 }).spawnProcess,
    });

    await expect(tick(makeCtx())).resolves.toBeUndefined();
  });

  it('rejects when the script exits with a non-zero code', async () => {
    const repoRoot = makeRepoRoot();
    const tick = createE2eAutoFixTick({
      logger: makeLogger(),
      repoRoot,
      spawnProcess: makeSpawnHarness({ exitCode: 1 }).spawnProcess,
    });

    await expect(tick(makeCtx())).rejects.toThrow('exited with code 1');
  });

  it('arms the default twelve-hour interval and does not tick on start', async () => {
    vi.useFakeTimers();
    const repoRoot = makeRepoRoot();
    const harness = makeSpawnHarness();
    const worker = createE2eAutoFixWorker({
      logger: makeLogger(),
      repoRoot,
      spawnProcess: harness.spawnProcess,
      installSignalHandlers: false,
    });

    worker.start();
    expect(harness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(DEFAULT_E2E_AUTOFIX_INTERVAL_MS - 1);
    expect(harness.calls).toEqual([]);

    await vi.advanceTimersByTimeAsync(1);
    expect(harness.calls).toHaveLength(1);
    await worker.stop();
  });
});

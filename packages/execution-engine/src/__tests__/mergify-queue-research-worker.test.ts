import { spawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import type { Logger } from '@invoker/contracts';

import type { WorkerTickContext } from '../worker-runtime.js';
import {
  DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_MS,
  MERGIFY_QUEUE_RESEARCH_SCRIPT_RELATIVE_PATH,
  MERGIFY_QUEUE_RESEARCH_WORKER_KIND,
  createMergifyQueueResearchTick,
  createMergifyQueueResearchWorker,
} from '../workers/mergify-queue-research-worker.js';

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
    identity: { kind: MERGIFY_QUEUE_RESEARCH_WORKER_KIND, instanceId: `${MERGIFY_QUEUE_RESEARCH_WORKER_KIND}-test` },
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

describe('mergify-queue-research worker', () => {
  it('uses a 14-day default interval', () => {
    expect(DEFAULT_MERGIFY_QUEUE_RESEARCH_INTERVAL_MS).toBe(14 * 86_400_000);
    const worker = createMergifyQueueResearchWorker({
      logger: makeLogger(),
      onTick: async () => {},
    });
    expect(worker.identity.kind).toBe(MERGIFY_QUEUE_RESEARCH_WORKER_KIND);
  });

  it('no-ops when hasMaps is unset', async () => {
    const { calls, spawnProcess } = makeSpawnHarness();
    const tick = createMergifyQueueResearchTick({
      logger: makeLogger(),
      spawnProcess,
    });
    await tick(makeCtx());
    expect(calls).toHaveLength(0);
  });

  it('no-ops without spawning when maps are empty', async () => {
    const { calls, spawnProcess } = makeSpawnHarness();
    const logger = makeLogger();
    const tick = createMergifyQueueResearchTick({
      logger,
      hasMaps: false,
      spawnProcess,
    });
    await tick(makeCtx());
    expect(calls).toHaveLength(0);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('empty maps'),
      expect.objectContaining({ worker: MERGIFY_QUEUE_RESEARCH_WORKER_KIND }),
    );
  });

  it('spawns the watch script when maps are present', async () => {
    const { calls, spawnProcess } = makeSpawnHarness({ stdout: 'ok\n' });
    const tick = createMergifyQueueResearchTick({
      logger: makeLogger(),
      hasMaps: true,
      repoRoot: '/tmp/invoker-repo',
      spawnProcess,
    });
    await tick(makeCtx());
    expect(calls).toHaveLength(1);
    expect(calls[0]?.command).toBe('bash');
    expect(calls[0]?.args[0]).toContain(MERGIFY_QUEUE_RESEARCH_SCRIPT_RELATIVE_PATH);
  });
});

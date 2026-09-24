import { describe, it, expect, vi } from 'vitest';

import { registerBuiltinWorkers } from '../builtin-workers.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import {
  DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS,
  SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH,
  SESSION_TOKEN_PUSH_WORKER_KIND,
} from '../workers/session-token-push-worker.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() { return this; },
};

function fakeSpawn() {
  return vi.fn(() => {
    const child = {
      stdout: { setEncoding() {}, on() {} },
      stderr: { setEncoding() {}, on() {} },
      once(event: string, cb: (code: number | null, signal: NodeJS.Signals | null) => void) {
        if (event === 'close') queueMicrotask(() => cb(0, null));
        return child;
      },
    };
    return child as never;
  });
}

function buildDeps(overrides: Partial<WorkerRuntimeDependencies['sessionTokenPush']> & {
  spawnProcess: ReturnType<typeof fakeSpawn>;
}): WorkerRuntimeDependencies {
  const { spawnProcess, ...config } = overrides;
  return {
    logger: silentLogger,
    sessionTokenPush: {
      repoRoot: process.cwd(),
      spawnProcess: spawnProcess as never,
      ...config,
    },
  } as unknown as WorkerRuntimeDependencies;
}

describe('session-token-push worker', () => {
  it('is registered as a built-in worker kind', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    expect(registry.get(SESSION_TOKEN_PUSH_WORKER_KIND)).toBeDefined();
  });

  it('defaults to a 7-day interval', () => {
    expect(DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS).toBe(7 * 24 * 60 * 60_000);
  });

  it('defaults to off: the built runtime is not running and spawns nothing', () => {
    const spawnProcess = fakeSpawn();
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const runtime = registry.get(SESSION_TOKEN_PUSH_WORKER_KIND)!.factory(buildDeps({ spawnProcess }));

    expect(runtime.identity.kind).toBe(SESSION_TOKEN_PUSH_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it('runs only scripts/cron-session-token-push.sh once switched on', async () => {
    const spawnProcess = fakeSpawn();
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const runtime = registry.get(SESSION_TOKEN_PUSH_WORKER_KIND)!.factory(buildDeps({
      spawnProcess,
      tickOnStart: true,
      installSignalHandlers: false,
    }));

    runtime.start();
    await runtime.stop({ settleTimeoutMs: 5_000 });

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [command, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(command).toBe('bash');
    expect(args).toHaveLength(1);
    expect(args[0]).toBe(`${process.cwd()}/${SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH}`);
  });
});

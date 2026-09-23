import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  SESSION_TOKEN_PUSH_WORKER_KIND,
  SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH,
  DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS,
  createSessionTokenPushWorker,
  createSessionTokenPushTick,
} from '../workers/session-token-push-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import { registerBuiltinWorkers } from '../builtin-workers.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

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
    return child as any;
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe('session-token-push worker', () => {
  it('is registered as a built-in worker kind', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    expect(registry.get(SESSION_TOKEN_PUSH_WORKER_KIND)).toBeDefined();
  });

  it('builds a stopped runtime from the built-in registry, so it is off until switched on', () => {
    const registry = registerBuiltinWorkers(createWorkerRegistry<WorkerRuntimeDependencies>());
    const runtime = registry.get(SESSION_TOKEN_PUSH_WORKER_KIND)!.factory({
      store: { listWorkflows: () => [], loadTasks: () => [], listWorkflowMutationIntents: () => [] },
      submitter: { submit: () => 0 },
      logger: silentLogger as any,
    } as unknown as WorkerRuntimeDependencies);
    expect(runtime.identity.kind).toBe(SESSION_TOKEN_PUSH_WORKER_KIND);
    expect(runtime.isRunning()).toBe(false);
  });

  it('runs nothing while off and runs the push script once switched on', async () => {
    const spawnProcess = fakeSpawn();
    const worker = createSessionTokenPushWorker({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      installSignalHandlers: false,
      spawnProcess: spawnProcess as any,
    });

    expect(worker.isRunning()).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();

    await worker.tick();
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('polls on a 7-day interval', async () => {
    vi.useFakeTimers();
    const spawnProcess = fakeSpawn();
    const worker = createSessionTokenPushWorker({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      installSignalHandlers: false,
      spawnProcess: spawnProcess as any,
    });

    expect(DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS).toBe(7 * 24 * 60 * 60 * 1000);

    worker.start();
    vi.advanceTimersByTime(DEFAULT_SESSION_TOKEN_PUSH_INTERVAL_MS - 1);
    expect(spawnProcess).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(spawnProcess).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('spawns scripts/cron-session-token-push.sh and nothing else', async () => {
    const spawnProcess = fakeSpawn();
    const tick = createSessionTokenPushTick({
      logger: silentLogger as any,
      repoRoot: '/srv/invoker',
      spawnProcess: spawnProcess as any,
    });

    await tick({} as any);

    expect(spawnProcess).toHaveBeenCalledTimes(1);
    const [shell, args] = spawnProcess.mock.calls[0] as unknown as [string, string[]];
    expect(shell).toBe('bash');
    expect(args).toEqual([`/srv/invoker/${SESSION_TOKEN_PUSH_SCRIPT_RELATIVE_PATH}`]);
  });
});

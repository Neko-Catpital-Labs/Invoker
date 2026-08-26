import { describe, it, expect, vi } from 'vitest';
import {
  WORKER_SESSION_MINE_WORKER_KIND,
  WORKER_SESSION_MINE_SCRIPT_RELATIVE_PATH,
  createWorkerSessionMineTick,
  registerWorkerSessionMineWorker,
} from '../workers/worker-session-mine-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const silentLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child() { return this; },
};

describe('worker-session-mine worker', () => {
  it('registers kind worker-session-mine', () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerWorkerSessionMineWorker(registry);
    expect(registry.get(WORKER_SESSION_MINE_WORKER_KIND)).toBeDefined();
  });

  it('spawns the cron shell entrypoint on tick', async () => {
    const spawnProcess = vi.fn(() => {
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

    const tick = createWorkerSessionMineTick({
      logger: silentLogger as any,
      repoRoot: process.cwd(),
      spawnProcess: spawnProcess as any,
    });
    await tick();
    expect(spawnProcess).toHaveBeenCalled();
    const args = spawnProcess.mock.calls[0]?.[1] as string[];
    expect(args.some((a) => a.includes(WORKER_SESSION_MINE_SCRIPT_RELATIVE_PATH) || a.endsWith('cron-worker-session-mine.sh'))).toBe(true);
  });
});

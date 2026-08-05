import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWorkerRuntime } from '../worker-runtime.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('recovery worker runtime wake storm', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(0));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('backs off a queued recovery wake after the in-flight tick fails', async () => {
    const backoffBaseMs = 20;
    const firstTick = deferred();
    const starts: number[] = [];
    let tickCount = 0;
    const onTick = vi.fn(async () => {
      starts.push(Date.now());
      tickCount += 1;
      if (tickCount === 1) {
        await firstTick.promise;
      }
      throw new Error('recovery failed');
    });
    const runtime = createWorkerRuntime({
      kind: 'recovery',
      logger,
      onTick,
      intervalMs: 0,
      tickOnStart: false,
      backoffBaseMs,
      installSignalHandlers: false,
    });

    runtime.start();
    runtime.wake();
    runtime.wake();
    expect(onTick).toHaveBeenCalledTimes(1);

    firstTick.resolve();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(backoffBaseMs - 1);
    expect(onTick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(onTick).toHaveBeenCalledTimes(2);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(backoffBaseMs);

    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop();
  });
});

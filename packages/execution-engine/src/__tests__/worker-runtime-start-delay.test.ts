import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRuntime } from '../worker-runtime.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

describe('createWorkerRuntime startDelayMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('defers the first tick and the poll interval until startDelayMs elapses', async () => {
    const onTick = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test',
      logger,
      onTick,
      intervalMs: 100,
      startDelayMs: 250,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    expect(onTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(onTick).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(100);
    expect(onTick).toHaveBeenCalledTimes(2);

    await runtime.stop();
  });

  it('ticks immediately with no startDelayMs (default 0, unchanged behavior)', async () => {
    const onTick = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test',
      logger,
      onTick,
      intervalMs: 100,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(onTick).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it('stop() before the start delay elapses cancels the pending timer cleanly', async () => {
    const onTick = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test',
      logger,
      onTick,
      intervalMs: 100,
      startDelayMs: 250,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(onTick).not.toHaveBeenCalled();
  });
});

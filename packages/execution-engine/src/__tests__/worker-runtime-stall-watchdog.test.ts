import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRuntime } from '../worker-runtime.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

// Regression fence for 2026-08-05: pr-admin-bypass-land stopped ticking at
// 07:02:45Z and nothing said so for over an hour. A hung or dead tick loop
// must announce itself: the watchdog logs an error once no tick activity has
// happened for 2x the poll interval.

describe('createWorkerRuntime stall watchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('logs an error when a hung tick blocks the loop for 2x the interval', async () => {
    const hangForever = () => new Promise<void>(() => {});
    const runtime = createWorkerRuntime({
      kind: 'test-stall',
      logger,
      onTick: hangForever,
      intervalMs: 100,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(150);
    expect(logger.error).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(200);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('looks stalled'),
      expect.anything(),
    );
    expect(logger.error).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(logger.error).toHaveBeenCalledTimes(1);

    await runtime.stop({ settleTimeoutMs: 0 });
  });

  it('healthy ticking never trips the watchdog', async () => {
    const runtime = createWorkerRuntime({
      kind: 'test-healthy',
      logger,
      onTick: vi.fn().mockResolvedValue(undefined),
      intervalMs: 100,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(logger.error).not.toHaveBeenCalled();

    await runtime.stop();
  });

  it('recovers after a stall: a completed tick re-arms the single-shot log for the next stall', async () => {
    let release: (() => void) | null = null;
    let mode: 'hang-releasable' | 'fast' | 'hang-forever' = 'hang-releasable';
    const runtime = createWorkerRuntime({
      kind: 'test-stall-recover',
      logger,
      onTick: () => {
        if (mode === 'fast') return Promise.resolve();
        if (mode === 'hang-forever') return new Promise<void>(() => {});
        return new Promise<void>((r) => { release = r; });
      },
      intervalMs: 100,
      tickOnStart: true,
      installSignalHandlers: false,
    });

    runtime.start();
    await vi.advanceTimersByTimeAsync(350);
    expect(logger.error).toHaveBeenCalledTimes(1);

    mode = 'fast';
    release?.();
    await vi.advanceTimersByTimeAsync(300);
    expect(logger.error).toHaveBeenCalledTimes(1);

    mode = 'hang-forever';
    await vi.advanceTimersByTimeAsync(400);
    expect(logger.error).toHaveBeenCalledTimes(2);

    await runtime.stop({ settleTimeoutMs: 0 });
  });
});

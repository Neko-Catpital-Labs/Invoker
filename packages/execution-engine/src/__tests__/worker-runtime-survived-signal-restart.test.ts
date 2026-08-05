import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkerRuntime } from '../worker-runtime.js';

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn(), child: vi.fn() };

// Regression fence for 2026-08-05T07:02:45Z: the owner process received a
// SIGTERM it survived; every worker's process.once handler stopped its
// runtime permanently, leaving a half-dead owner (running workflows, no
// PR-maintenance workers, no scanning) for over an hour with only an info
// log. With restartAfterSurvivedSignalMs set, a signal the process outlives
// restarts the worker and logs an error.

const TEST_SIGNAL = 'SIGUSR2' as const;

describe('createWorkerRuntime restartAfterSurvivedSignalMs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    process.removeAllListeners(TEST_SIGNAL);
  });

  it('restarts the worker when the process survives a shutdown signal', async () => {
    const onTick = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test-survivor',
      logger,
      onTick,
      intervalMs: 0,
      tickOnStart: false,
      shutdownSignals: [TEST_SIGNAL],
      installSignalHandlers: true,
      restartAfterSurvivedSignalMs: 50,
    });

    runtime.start();
    expect(runtime.isRunning()).toBe(true);

    process.emit(TEST_SIGNAL, TEST_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.isRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.isRunning()).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('process survived SIGUSR2'),
      expect.anything(),
    );

    await runtime.tick();
    expect(onTick).toHaveBeenCalledTimes(1);

    await runtime.stop();
  });

  it('a second survived signal after restart restarts again', async () => {
    const runtime = createWorkerRuntime({
      kind: 'test-survivor-twice',
      logger,
      onTick: vi.fn(),
      intervalMs: 0,
      tickOnStart: false,
      shutdownSignals: [TEST_SIGNAL],
      installSignalHandlers: true,
      restartAfterSurvivedSignalMs: 50,
    });

    runtime.start();
    process.emit(TEST_SIGNAL, TEST_SIGNAL);
    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.isRunning()).toBe(true);

    process.emit(TEST_SIGNAL, TEST_SIGNAL);
    await vi.advanceTimersByTimeAsync(0);
    expect(runtime.isRunning()).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(runtime.isRunning()).toBe(true);

    await runtime.stop();
  });

  it('default behavior is unchanged: signal stop is final', async () => {
    const runtime = createWorkerRuntime({
      kind: 'test-final-stop',
      logger,
      onTick: vi.fn(),
      intervalMs: 0,
      tickOnStart: false,
      shutdownSignals: [TEST_SIGNAL],
      installSignalHandlers: true,
    });

    runtime.start();
    process.emit(TEST_SIGNAL, TEST_SIGNAL);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(runtime.isRunning()).toBe(false);
  });
});

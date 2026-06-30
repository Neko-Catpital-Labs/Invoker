import { afterEach, describe, expect, it, vi } from 'vitest';

import { createPrStatusWorker } from '../review-gate-status-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

describe('pr-status worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('polls review-gate status in owner mode', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = createPrStatusWorker({
      reviewGate: { checkMergeGateStatuses },
      logger,
      intervalMs: 1000,
      installSignalHandlers: false,
    });
    worker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    await worker.stop();
  });

  it('starts even when startup auto-run is disabled', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = createPrStatusWorker({
      reviewGate: { checkMergeGateStatuses },
      logger,
      intervalMs: 1000,
      installSignalHandlers: false,
    });
    worker.start();

    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    await worker.stop();
  });


  it('does not overlap ticks', async () => {
    vi.useFakeTimers();
    let resolveFirst!: () => void;
    const firstTick = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    const checkMergeGateStatuses = vi.fn()
      .mockReturnValueOnce(firstTick)
      .mockResolvedValue(undefined);

    const worker = createPrStatusWorker({
      reviewGate: { checkMergeGateStatuses },
      logger,
      intervalMs: 1000,
      installSignalHandlers: false,
    });
    worker.start();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstTick;
    await vi.advanceTimersByTimeAsync(0);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('continues after a tick error', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const worker = createPrStatusWorker({
      reviewGate: { checkMergeGateStatuses },
      logger,
      intervalMs: 1000,
      installSignalHandlers: false,
    });
    worker.start();

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('[worker:pr-status] tick failed', expect.any(Object));
    await worker.stop();
  });

  it('clears the interval on shutdown', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = createPrStatusWorker({
      reviewGate: { checkMergeGateStatuses },
      logger,
      intervalMs: 1000,
      installSignalHandlers: false,
    });
    worker.start();

    await worker.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
  });
});

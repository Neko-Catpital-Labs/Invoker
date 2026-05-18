import { afterEach, describe, expect, it, vi } from 'vitest';

import { startReviewGateStatusWorker } from '../review-gate-status-worker.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
};

describe('review-gate status worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('starts in owner mode', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    expect(worker).not.toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    worker?.stop();
  });

  it('starts in owner mode even when startup auto-run is disabled', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);
    worker?.stop();
  });

  it('does not start in follower or read-only mode', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: false,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    expect(worker).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
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

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(1);

    resolveFirst();
    await firstTick;
    await vi.advanceTimersByTimeAsync(1000);
    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    worker?.stop();
  });

  it('continues after a tick error', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(checkMergeGateStatuses).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledWith('review-gate status worker tick failed', expect.any(Object));
    worker?.stop();
  });

  it('clears the interval on shutdown', async () => {
    vi.useFakeTimers();
    const checkMergeGateStatuses = vi.fn().mockResolvedValue(undefined);

    const worker = startReviewGateStatusWorker({
      ownerMode: true,
      getTaskExecutor: () => ({ checkMergeGateStatuses }),
      logger,
      intervalMs: 1000,
    });

    worker?.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(checkMergeGateStatuses).not.toHaveBeenCalled();
  });
});

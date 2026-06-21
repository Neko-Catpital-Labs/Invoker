import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createRecoveryWorker,
  RECOVERY_WORKER_KIND,
} from '../workers/auto-fix-recovery.js';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  trace: vi.fn(),
  child: vi.fn(),
};

describe('auto-fix recovery worker', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('exposes the recovery identity', () => {
    const runtime = createRecoveryWorker({ logger, instanceId: 'rec-1', installSignalHandlers: false });
    expect(runtime.identity).toEqual({ kind: RECOVERY_WORKER_KIND, instanceId: 'rec-1' });
  });

  it('is behavior-neutral: its default tick does nothing and does not throw', async () => {
    const runtime = createRecoveryWorker({ logger, instanceId: 'rec-2', installSignalHandlers: false });
    await expect(runtime.tick()).resolves.toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
    await runtime.stop();
  });

  it('does not auto-run a tick on start', async () => {
    vi.useFakeTimers();
    const onTick = vi.fn();
    const runtime = createRecoveryWorker({
      logger,
      instanceId: 'rec-3',
      intervalMs: 1000,
      onTick,
      installSignalHandlers: false,
    });
    runtime.start();
    await Promise.resolve();
    // tickOnStart defaults to false for the recovery worker.
    expect(onTick).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(onTick).toHaveBeenCalledTimes(1);
    await runtime.stop();
  });
});

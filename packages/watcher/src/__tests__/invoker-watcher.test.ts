import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createInvokerWatcher } from '../invoker-watcher.js';

describe('createInvokerWatcher', () => {
  const downThresholdMs = 20 * 60_000;
  const restartCooldownMs = 15 * 60_000;
  let healthy: boolean;
  let currentTime: number;
  let isHealthy: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  let restart: ReturnType<typeof vi.fn<() => Promise<void>>>;
  let log: ReturnType<typeof vi.fn<(level: string, message: string) => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    healthy = true;
    currentTime = 0;
    isHealthy = vi.fn(async () => healthy);
    restart = vi.fn(async () => {});
    log = vi.fn();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makeWatcher() {
    return createInvokerWatcher({
      client: { isHealthy },
      restart,
      log,
      pollIntervalMs: 1_000,
      downThresholdMs,
      restartCooldownMs,
      now: () => currentTime,
    });
  }

  async function flushPromises(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
  }

  it('does not restart before the continuous unhealthy threshold elapses', async () => {
    const watcher = makeWatcher();
    healthy = false;

    await watcher.tick();
    currentTime = downThresholdMs - 1;
    await watcher.tick();

    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts exactly once at the continuous unhealthy threshold', async () => {
    const watcher = makeWatcher();
    healthy = false;

    await watcher.tick();
    currentTime = downThresholdMs;
    await watcher.tick();
    await watcher.tick();

    expect(restart).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith('error', expect.stringContaining(`${downThresholdMs}ms`));
  });

  it('respects restart cooldown during one continuous unhealthy period', async () => {
    const watcher = makeWatcher();
    healthy = false;

    await watcher.tick();
    currentTime = downThresholdMs;
    await watcher.tick();
    currentTime = downThresholdMs + restartCooldownMs - 1;
    await watcher.tick();
    currentTime = downThresholdMs + restartCooldownMs;
    await watcher.tick();

    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('requires a fresh threshold window after a healthy poll', async () => {
    const watcher = makeWatcher();
    healthy = false;

    await watcher.tick();
    currentTime = downThresholdMs;
    await watcher.tick();

    healthy = true;
    await watcher.tick();

    healthy = false;
    currentTime += 1;
    await watcher.tick();
    currentTime += downThresholdMs - 1;
    await watcher.tick();
    expect(restart).toHaveBeenCalledTimes(1);

    currentTime += 1;
    await watcher.tick();
    expect(restart).toHaveBeenCalledTimes(2);
  });

  it('starts immediately, keeps polling, and logs individual tick failures', async () => {
    isHealthy
      .mockRejectedValueOnce(new Error('ipc unavailable'))
      .mockResolvedValue(true);
    const watcher = makeWatcher();

    watcher.start();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    watcher.stop();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(isHealthy).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith('error', 'watcher tick failed: ipc unavailable');
  });
});

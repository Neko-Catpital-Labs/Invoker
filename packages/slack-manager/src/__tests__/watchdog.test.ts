import { describe, it, expect, vi } from 'vitest';
import { createWatchdog } from '../watchdog.js';

interface HealthLaunch {
  isHealthy: () => Promise<boolean>;
  launch: () => Promise<boolean>;
}

describe('createWatchdog', () => {
  it('relaunches after the failure threshold and not more than once per backoff window', async () => {
    let nowMs = 1_000_000;
    const launch = vi.fn(async () => false); // Invoker stays down
    const client: HealthLaunch = { isHealthy: vi.fn(async () => false), launch };
    const wd = createWatchdog({
      client, log: () => {}, alert: vi.fn(),
      failuresBeforeRelaunch: 2, maxAttempts: 5,
      baseBackoffMs: 60_000, maxBackoffMs: 300_000,
      now: () => nowMs,
    });

    await wd.tick(); // failure 1 — below threshold
    expect(launch).toHaveBeenCalledTimes(0);
    await wd.tick(); // failure 2 — first relaunch
    expect(launch).toHaveBeenCalledTimes(1);
    await wd.tick(); // still inside the backoff window
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);

    nowMs += 61_000; // past the 60s window
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('gives up and alerts after maxAttempts, then stops auto-restarting', async () => {
    let nowMs = 0;
    const launch = vi.fn(async () => false);
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      now: () => nowMs,
    });

    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    nowMs += 2_000; await wd.tick();
    expect(launch).toHaveBeenCalledTimes(2);
    nowMs += 2_000; await wd.tick();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(1);

    nowMs += 10_000; await wd.tick(); // gave up — no further launches
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it('resets after a successful relaunch', async () => {
    let nowMs = 0;
    const launch = vi.fn(async () => true); // relaunch succeeds
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert: vi.fn(),
      failuresBeforeRelaunch: 1, baseBackoffMs: 60_000,
      now: () => nowMs,
    });
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    // success reset the window → next failure relaunches again immediately
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('resets when Invoker recovers on its own', async () => {
    let nowMs = 0;
    let healthy = false;
    const launch = vi.fn(async () => false);
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => healthy), launch },
      log: () => {}, alert: vi.fn(),
      failuresBeforeRelaunch: 1, baseBackoffMs: 60_000,
      now: () => nowMs,
    });
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    healthy = true; await wd.tick(); // recovered → reset
    healthy = false; nowMs += 100; await wd.tick(); // fresh failure relaunches without waiting a window
    expect(launch).toHaveBeenCalledTimes(2);
  });
});

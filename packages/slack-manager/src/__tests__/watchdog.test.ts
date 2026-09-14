import { describe, it, expect, vi } from 'vitest';
import { createWatchdog } from '../watchdog.js';
import type { LaunchResult } from '../invoker-client.js';

interface HealthLaunch {
  isHealthy: () => Promise<boolean>;
  launch: () => Promise<LaunchResult>;
}

describe('createWatchdog', () => {
  it('relaunches after the failure threshold and not more than once per backoff window', async () => {
    let nowMs = 1_000_000;
    const launch = vi.fn(async (): Promise<LaunchResult> => ({ healthy: false, cause: 'unhealthy' })); // Invoker stays down
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

  it('gives up and alerts after maxAttempts, then only retries at the slow give-up cadence', async () => {
    let nowMs = 0;
    const launch = vi.fn(async (): Promise<LaunchResult> => ({ healthy: false, cause: 'unhealthy' }));
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 3, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      giveUpRetryIntervalMs: 100_000,
      now: () => nowMs,
    });

    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);
    nowMs += 2_000; await wd.tick();
    expect(launch).toHaveBeenCalledTimes(2);
    nowMs += 2_000; await wd.tick();
    expect(launch).toHaveBeenCalledTimes(3);
    expect(alert).toHaveBeenCalledTimes(1);

    nowMs += 10_000; await wd.tick(); // gave up — still inside the slow give-up cadence, no launch yet
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it('after giving up, keeps trying at giveUpRetryIntervalMs instead of staying down forever', async () => {
    // Reproduces the production incident (2026-08-29): a genuine split-brain blocked the
    // final fast-retry attempt, the blocking process died on its own minutes later, but the
    // old code never tried again — Invoker stayed down 10+ hours until a human manually
    // replied `@Invoker restart`. The watchdog must keep trying at a slow, non-spammy cadence,
    // and recover on its own once the real-world blocker is gone.
    let nowMs = 0;
    let blockerGone = false;
    let ownerHealthy = false;
    const launch = vi.fn(async (): Promise<LaunchResult> => {
      if (!blockerGone) return { healthy: false, cause: 'split-brain', holderPid: 999 };
      ownerHealthy = true;
      return { healthy: true };
    });
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => ownerHealthy), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 2, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      giveUpRetryIntervalMs: 50_000,
      alertCooldownMs: 1_000_000, // isolate the retry-cadence assertion from alert spam
      now: () => nowMs,
    });

    await wd.tick();
    nowMs += 2_000; await wd.tick();
    expect(launch).toHaveBeenCalledTimes(2); // gave up here

    nowMs += 10_000; await wd.tick(); // well inside giveUpRetryIntervalMs — no retry yet
    expect(launch).toHaveBeenCalledTimes(2);

    nowMs += 50_000; await wd.tick(); // past giveUpRetryIntervalMs — one more attempt, still blocked
    expect(launch).toHaveBeenCalledTimes(3);

    // The real-world blocker (the stray split-brain process) has now died on its own.
    blockerGone = true;
    nowMs += 50_000; await wd.tick(); // next slow-cadence attempt succeeds
    expect(launch).toHaveBeenCalledTimes(4);
    expect(ownerHealthy).toBe(true);
  });

  it('keeps attempt state after a successful relaunch until health is stable', async () => {
    let nowMs = 0;
    let healthy = false;
    const launch = vi.fn(async (): Promise<LaunchResult> => {
      healthy = true;
      return { healthy: true };
    });
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => healthy), launch },
      log: () => {}, alert: vi.fn(),
      failuresBeforeRelaunch: 1, baseBackoffMs: 60_000,
      stableHealthyPolls: 3,
      now: () => nowMs,
    });
    await wd.tick(); // down → launch succeeds
    expect(launch).toHaveBeenCalledTimes(1);

    healthy = false; // flap immediately
    nowMs += 100;
    await wd.tick(); // still counts as recovery; launches again
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it('resets only after enough consecutive healthy polls', async () => {
    let nowMs = 0;
    let healthy = false;
    const launch = vi.fn(async (): Promise<LaunchResult> => ({ healthy: false, cause: 'unhealthy' }));
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => healthy), launch },
      log: () => {}, alert: vi.fn(),
      failuresBeforeRelaunch: 1, baseBackoffMs: 60_000,
      stableHealthyPolls: 3,
      now: () => nowMs,
    });
    await wd.tick();
    expect(launch).toHaveBeenCalledTimes(1);

    healthy = true;
    await wd.tick(); // 1/3
    await wd.tick(); // 2/3
    healthy = false; nowMs += 100; await wd.tick(); // flap before stable → relaunch
    expect(launch).toHaveBeenCalledTimes(2);

    healthy = true;
    await wd.tick();
    await wd.tick();
    await wd.tick(); // 3/3 → reset
    healthy = false; nowMs += 100; await wd.tick(); // fresh failure after full recovery
    expect(launch).toHaveBeenCalledTimes(3);
  });

  it('names the unreachable lock holder in the give-up alert on split-brain', async () => {
    let nowMs = 0;
    const launch = vi.fn(async (): Promise<LaunchResult> => ({ healthy: false, cause: 'split-brain', holderPid: 4242 }));
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 1, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      now: () => nowMs,
    });

    await wd.tick();
    expect(alert).toHaveBeenCalledTimes(1);
    const message = (alert.mock.calls[0] as string[])[0];
    expect(message).toContain('PID 4242');
    expect(message).toContain('`@Invoker restart`');
  });

  it('gives an honest "could not confirm" alert on lock-unknown, never claiming a specific PID is alive', async () => {
    let nowMs = 0;
    const launch = vi.fn(async (): Promise<LaunchResult> => (
      { healthy: false, cause: 'lock-unknown', lockReadError: 'EACCES' }
    ));
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 1, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      now: () => nowMs,
    });

    await wd.tick();
    expect(alert).toHaveBeenCalledTimes(1);
    const message = (alert.mock.calls[0] as string[])[0];
    expect(message).toContain('EACCES');
    expect(message).toContain('could not confirm');
    expect(message).toContain('`@Invoker restart`');
    expect(message).not.toContain('is alive but not');
    expect(message).not.toContain('PID undefined');
  });

  it('rate-limits repeated give-up alerts while Invoker stays down', async () => {
    let nowMs = 0;
    const launch = vi.fn(async (): Promise<LaunchResult> => ({ healthy: false, cause: 'unhealthy' }));
    const alert = vi.fn();
    const wd = createWatchdog({
      client: { isHealthy: vi.fn(async () => false), launch },
      log: () => {}, alert,
      failuresBeforeRelaunch: 1, maxAttempts: 1, baseBackoffMs: 1_000, maxBackoffMs: 1_000,
      alertCooldownMs: 60_000,
      now: () => nowMs,
    });

    await wd.tick();
    expect(alert).toHaveBeenCalledTimes(1);

    nowMs += 1_000; await wd.tick(); // still within cooldown
    expect(alert).toHaveBeenCalledTimes(1);

    nowMs += 60_000; await wd.tick(); // cooldown elapsed → remind once
    expect(alert).toHaveBeenCalledTimes(2);
  });
});

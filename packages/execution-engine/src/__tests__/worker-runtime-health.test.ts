import { describe, it, expect, vi } from 'vitest';
import { createWorkerRuntime } from '../worker-runtime.js';

function makeLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
}

describe('WorkerRuntime worker health', () => {
  it('worker health streak grows across separate tick() calls', async () => {
    const onTick = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();
    const runtime = createWorkerRuntime({
      kind: 'test-health-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
    });

    await runtime.tick();
    expect(runtime.health().consecutiveFailedTicks).toBe(1);

    await runtime.tick();
    expect(runtime.health().consecutiveFailedTicks).toBe(2);

    await runtime.tick();
    expect(runtime.health().consecutiveFailedTicks).toBe(3);
  });

  it('worker health success resets the streak', async () => {
    const onTick = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const logger = makeLogger();
    const runtime = createWorkerRuntime({
      kind: 'test-health-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
    });

    await runtime.tick();
    expect(runtime.health().consecutiveFailedTicks).toBe(1);

    await runtime.tick();
    const health = runtime.health();
    expect(health.consecutiveFailedTicks).toBe(0);
    expect(health.failingSince).toBeNull();
    expect(health.lastFailedAt).toBeNull();
    expect(health.lastError).toBeNull();
  });

  it('worker health failingSince stays at the first failure in a streak', async () => {
    const onTick = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();
    const runtime = createWorkerRuntime({
      kind: 'test-health-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
    });

    await runtime.tick();
    const firstFailingSince = runtime.health().failingSince;
    expect(firstFailingSince).not.toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await runtime.tick();
    const health = runtime.health();
    expect(health.consecutiveFailedTicks).toBe(2);
    expect(health.failingSince).toBe(firstFailingSince);
  });

  it('worker health records the first line of the error message, capped at 500 chars, and calls onHealthChange', async () => {
    const longMessage = `first line\n${'x'.repeat(600)}`;
    const onTick = vi.fn().mockRejectedValue(new Error(longMessage));
    const logger = makeLogger();
    const onHealthChange = vi.fn();
    const runtime = createWorkerRuntime({
      kind: 'test-health-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
      onHealthChange,
    });

    await runtime.tick();
    const health = runtime.health();
    expect(health.lastError).toBe('first line');
    expect(onHealthChange).toHaveBeenCalledWith(expect.objectContaining({ consecutiveFailedTicks: 1 }));

    const onTickLong = vi.fn().mockRejectedValue(new Error('y'.repeat(600)));
    const runtime2 = createWorkerRuntime({
      kind: 'test-health-worker-2',
      onTick: onTickLong,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
    });
    await runtime2.tick();
    expect(runtime2.health().lastError?.length).toBe(500);
  });

  it('worker health onHealthChange throwing is logged at warn and does not propagate', async () => {
    const onTick = vi.fn().mockRejectedValue(new Error('boom'));
    const logger = makeLogger();
    const onHealthChange = vi.fn().mockImplementation(() => {
      throw new Error('listener exploded');
    });
    const runtime = createWorkerRuntime({
      kind: 'test-health-worker',
      onTick,
      logger: logger as any,
      intervalMs: 0,
      tickOnStart: false,
      onHealthChange,
    });

    await expect(runtime.tick()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});

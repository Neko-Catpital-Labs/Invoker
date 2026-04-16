import { describe, expect, it } from 'vitest';
import { computeDeferredLaunchTiming } from '../deferred-runnable.js';

describe('computeDeferredLaunchTiming', () => {
  it('caps repeated coalescing delay once max deferral window is exhausted', () => {
    const first = computeDeferredLaunchTiming({
      nowMs: 1_000,
      deferDelayMs: 25,
      maxCoalesceMs: 50,
    });
    expect(first.firstScheduledAtMs).toBe(1_000);
    expect(first.delayMs).toBe(25);

    const nearCap = computeDeferredLaunchTiming({
      existingFirstScheduledAtMs: first.firstScheduledAtMs,
      nowMs: 1_040,
      deferDelayMs: 25,
      maxCoalesceMs: 50,
    });
    expect(nearCap.delayMs).toBe(10);

    const exhausted = computeDeferredLaunchTiming({
      existingFirstScheduledAtMs: first.firstScheduledAtMs,
      nowMs: 1_080,
      deferDelayMs: 25,
      maxCoalesceMs: 50,
    });
    expect(exhausted.delayMs).toBe(0);
  });
});

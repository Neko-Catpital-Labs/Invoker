import { describe, expect, it } from 'vitest';

import {
  createInvestigationPlanThrottle,
  DEFAULT_INVESTIGATION_COOLDOWN_MS,
} from '../workers/investigation-plan-throttle.js';

describe('createInvestigationPlanThrottle', () => {
  it('returns DEFAULT_INVESTIGATION_COOLDOWN_MS equal to one hour', () => {
    expect(DEFAULT_INVESTIGATION_COOLDOWN_MS).toBe(60 * 60_000);
  });

  it('allows the first investigation for a key', () => {
    const throttle = createInvestigationPlanThrottle(60_000);
    expect(throttle.isThrottled('worker:foo')).toBe(false);
  });

  it('marks an investigation so a second call within cooldown is throttled', () => {
    const throttle = createInvestigationPlanThrottle(60_000);
    throttle.mark('worker:foo');
    expect(throttle.isThrottled('worker:foo')).toBe(true);
  });

  it('does not throttle different keys', () => {
    const throttle = createInvestigationPlanThrottle(60_000);
    throttle.mark('worker:foo');
    expect(throttle.isThrottled('worker:bar')).toBe(false);
  });

  it('respects a custom now value for deterministic testing', () => {
    const throttle = createInvestigationPlanThrottle(60_000);
    const now = 1_000_000;
    throttle.mark('worker:foo', now);
    expect(throttle.isThrottled('worker:foo', now + 30_000)).toBe(true);
    expect(throttle.isThrottled('worker:foo', now + 60_001)).toBe(false);
  });

  it('can be rehydrated from an existing entries map', () => {
    const entries = new Map<string, number>([['worker:baz', Date.now()]]);
    const throttle = createInvestigationPlanThrottle(60_000, entries);
    expect(throttle.isThrottled('worker:baz')).toBe(true);
  });

  it('disables throttling when cooldownMs is zero or negative', () => {
    const throttle = createInvestigationPlanThrottle(0);
    throttle.mark('worker:foo');
    expect(throttle.isThrottled('worker:foo')).toBe(false);

    const negativeThrottle = createInvestigationPlanThrottle(-1000);
    negativeThrottle.mark('worker:bar');
    expect(negativeThrottle.isThrottled('worker:bar')).toBe(false);
  });
});

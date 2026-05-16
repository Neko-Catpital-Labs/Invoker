import { describe, expect, it } from 'vitest';
import { evaluateLaunchStall } from '../launch-stall.js';

const now = new Date('2026-05-16T01:00:00.000Z');
const staleLaunchStartedAt = new Date('2026-05-16T00:59:00.000Z');

describe('evaluateLaunchStall', () => {
  it('ignores reset-created pending attempts with stale launch metadata', () => {
    const result = evaluateLaunchStall({
      now,
      status: 'pending',
      phase: 'launching',
      launchStartedAt: staleLaunchStartedAt,
      selectedAttempt: { status: 'pending' },
      hasExecutionHandle: false,
      isKnownLaunching: false,
      launchingStallTimeoutMs: 3_000,
    });

    expect(result.launchClaimedForCurrentAttempt).toBe(false);
    expect(result.launchStalled).toBe(false);
  });

  it('fails pending launching tasks only after the selected attempt is launch-claimed', () => {
    const result = evaluateLaunchStall({
      now,
      status: 'pending',
      phase: 'launching',
      launchStartedAt: staleLaunchStartedAt,
      selectedAttempt: { status: 'claimed', claimedAt: staleLaunchStartedAt },
      hasExecutionHandle: false,
      isKnownLaunching: false,
      launchingStallTimeoutMs: 3_000,
    });

    expect(result.launchClaimedForCurrentAttempt).toBe(true);
    expect(result.launchStalled).toBe(true);
  });

  it('preserves launch-stall detection for running tasks', () => {
    const result = evaluateLaunchStall({
      now,
      status: 'running',
      phase: 'launching',
      launchStartedAt: staleLaunchStartedAt,
      hasExecutionHandle: false,
      isKnownLaunching: false,
      launchingStallTimeoutMs: 3_000,
    });

    expect(result.launchClaimedForCurrentAttempt).toBe(true);
    expect(result.launchStalled).toBe(true);
  });
});

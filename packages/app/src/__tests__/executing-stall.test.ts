import { describe, expect, it } from 'vitest';
import { evaluateExecutingStall } from '../executing-stall.js';

describe('evaluateExecutingStall', () => {
  const now = new Date('2026-05-13T08:00:00.000Z');
  const timeoutMs = 120_000;
  const startedAt = new Date(now.getTime() - 5 * 60_000);

  it('treats stale remote heartbeat as stalled for SSH tasks', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      executorType: 'ssh',
      executingStartedAt: startedAt,
      executorHeartbeatAt: new Date(now.getTime() - 10_000),
      remoteHeartbeatAt: new Date(now.getTime() - 4 * 60_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(true);
    expect(result.staleReason).toBe('remote workload heartbeat stale');
  });

  it('keeps SSH task healthy when remote heartbeat is fresh', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      executorType: 'ssh',
      executingStartedAt: startedAt,
      executorHeartbeatAt: new Date(now.getTime() - 4 * 60_000),
      remoteHeartbeatAt: new Date(now.getTime() - 20_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(false);
    expect(result.heartbeatStale).toBe(false);
  });

  it('uses executor heartbeat for non-SSH tasks', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      executorType: 'worktree',
      executingStartedAt: startedAt,
      executorHeartbeatAt: new Date(now.getTime() - 4 * 60_000),
      remoteHeartbeatAt: new Date(now.getTime() - 20_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(true);
    expect(result.staleReason).toBe('executor heartbeat stale');
  });

  it('prioritizes lease expiration as the stale reason', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      executorType: 'ssh',
      executingStartedAt: startedAt,
      remoteHeartbeatAt: new Date(now.getTime() - 5_000),
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(true);
    expect(result.staleReason).toBe('attempt lease expired');
  });
});

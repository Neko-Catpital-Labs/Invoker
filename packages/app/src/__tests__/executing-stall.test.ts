import { describe, expect, it } from 'vitest';
import { evaluateExecutingStall, taskNeedsExecutingStallCheck } from '../executing-stall.js';
import type { TaskState } from '@invoker/workflow-core';

describe('evaluateExecutingStall', () => {
  const now = new Date('2026-05-13T08:00:00.000Z');
  const timeoutMs = 120_000;
  const startedAt = new Date(now.getTime() - 5 * 60_000);

  it('treats stale remote heartbeat as stalled for SSH tasks', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      runnerKind: 'ssh',
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
      runnerKind: 'ssh',
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
      runnerKind: 'worktree',
      executingStartedAt: startedAt,
      executorHeartbeatAt: new Date(now.getTime() - 4 * 60_000),
      remoteHeartbeatAt: new Date(now.getTime() - 20_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(true);
    expect(result.staleReason).toBe('executor heartbeat stale');
  });

  it('does not terminally stall a worktree task on heartbeat gap alone while the attempt lease is still valid', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      runnerKind: 'worktree',
      executingStartedAt: startedAt,
      executorHeartbeatAt: new Date(now.getTime() - 4 * 60_000),
      leaseExpiresAt: new Date(now.getTime() + 10 * 60_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.heartbeatStale).toBe(true);
    expect(result.leaseExpired).toBe(false);
    expect(result.executingStalled).toBe(false);
  });

  it('prioritizes lease expiration as the stale reason', () => {
    const result = evaluateExecutingStall({
      now,
      phase: 'executing',
      runnerKind: 'ssh',
      executingStartedAt: startedAt,
      remoteHeartbeatAt: new Date(now.getTime() - 5_000),
      leaseExpiresAt: new Date(now.getTime() - 1_000),
      executingStallTimeoutMs: timeoutMs,
    });

    expect(result.executingStalled).toBe(true);
    expect(result.staleReason).toBe('attempt lease expired');
  });
});

describe('taskNeedsExecutingStallCheck', () => {
  function task(status: string, phase?: string): Pick<TaskState, 'status' | 'execution'> {
    return { status, execution: { phase } } as unknown as Pick<TaskState, 'status' | 'execution'>;
  }

  it('selects running, launching, and fixing tasks (the only stall-eligible states)', () => {
    expect(taskNeedsExecutingStallCheck(task('running'))).toBe(true);
    expect(taskNeedsExecutingStallCheck(task('fixing_with_ai'))).toBe(true);
    expect(taskNeedsExecutingStallCheck(task('pending', 'launching'))).toBe(true);
  });

  it('skips idle and terminal tasks so the db-poll loads no attempt for them', () => {
    expect(taskNeedsExecutingStallCheck(task('pending'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(task('pending', 'executing'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(task('completed'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(task('failed'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(task('closed'))).toBe(false);
    expect(taskNeedsExecutingStallCheck(task('review_ready'))).toBe(false);
  });

  it('collapses the per-tick attempt-load count to the stall-eligible tasks under a storm', () => {
    // Mirrors the live storm: dozens of idle pending frontier tasks, a couple of
    // running/fixing ones. Before gating the db-poll loaded an attempt for EVERY
    // task each 2s tick; now only the eligible few incur the heavy attempt query.
    const storm: Pick<TaskState, 'status' | 'execution'>[] = [
      ...Array.from({ length: 50 }, () => task('pending')),
      task('running'),
      task('pending', 'launching'),
      task('fixing_with_ai'),
      ...Array.from({ length: 5 }, () => task('completed')),
    ];
    const needingLoad = storm.filter(taskNeedsExecutingStallCheck);
    expect(needingLoad).toHaveLength(3);
    expect(storm.length).toBe(58);
  });
});

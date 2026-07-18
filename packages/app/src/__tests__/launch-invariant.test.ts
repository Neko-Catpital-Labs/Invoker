import { describe, expect, it } from 'vitest';
import type { TaskEvent } from '@invoker/data-store';
import { DISPATCH_LEASE_MS, DISPATCH_MAX_ATTEMPTS } from '@invoker/contracts';
import {
  DEFAULT_LAUNCH_INVARIANT_MAX_GAP_MS,
  LaunchInvariantViolationError,
  assertLaunchInvariant,
} from './launch-invariant.js';

interface FixturePersistence {
  getAllTaskIds(): string[];
  getEvents(taskId: string): TaskEvent[];
}

function buildPersistence(
  perTaskEvents: Record<string, Array<Omit<TaskEvent, 'taskId'>>>,
): FixturePersistence {
  return {
    getAllTaskIds: () => Object.keys(perTaskEvents),
    getEvents: (taskId) =>
      (perTaskEvents[taskId] ?? []).map((event) => ({ ...event, taskId })),
  };
}

const T0 = '2026-05-22T01:55:56.000Z';
const T1 = '2026-05-22T01:55:57.000Z';
const T1_PLUS_20MIN = '2026-05-22T02:15:57.000Z';

describe('assertLaunchInvariant', () => {
  it('passes when every claim is followed by a terminal launch event', () => {
    const persistence = buildPersistence({
      'task-a': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
        { id: 2, eventType: 'task.executor.selected', payload: undefined, createdAt: T1 },
        { id: 3, eventType: 'task.running', payload: undefined, createdAt: T1 },
      ],
    });

    const result = assertLaunchInvariant(persistence, { maxGapMs: 5_000 });

    expect(result.taskCount).toBe(1);
    expect(result.claimCount).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it('throws when a claim has no resolving terminal event and is older than maxGapMs', () => {
    const persistence = buildPersistence({
      'task-orphan': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
      ],
    });

    try {
      assertLaunchInvariant(persistence, {
        maxGapMs: 60_000,
        nowMs: Date.parse(T1_PLUS_20MIN),
      });
      throw new Error('expected violation');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchInvariantViolationError);
      const violations = (err as LaunchInvariantViolationError).violations;
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe('no_terminal_event');
      expect(violations[0].taskId).toBe('task-orphan');
    }
  });

  it('throws when a claim is followed only by a fresh claim (orphan-then-reclaim)', () => {
    const persistence = buildPersistence({
      'task-reclaim': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
        { id: 2, eventType: 'task.launch_claimed', payload: undefined, createdAt: T1_PLUS_20MIN },
        { id: 3, eventType: 'task.executor.selected', payload: undefined, createdAt: T1_PLUS_20MIN },
      ],
    });

    try {
      assertLaunchInvariant(persistence, {
        maxGapMs: 60_000,
        nowMs: Date.parse('2026-05-22T03:00:00.000Z'),
      });
      throw new Error('expected violation');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchInvariantViolationError);
      const violations = (err as LaunchInvariantViolationError).violations;
      expect(violations).toHaveLength(1);
      expect(violations[0].claimEventId).toBe(1);
      expect(violations[0].reason).toBe('no_terminal_event');
    }
  });

  it('throws when the gap between claim and terminal event exceeds maxGapMs', () => {
    const persistence = buildPersistence({
      'task-slow': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
        { id: 2, eventType: 'task.executor.selected', payload: undefined, createdAt: T1_PLUS_20MIN },
      ],
    });

    try {
      assertLaunchInvariant(persistence, { maxGapMs: 60_000 });
      throw new Error('expected violation');
    } catch (err) {
      expect(err).toBeInstanceOf(LaunchInvariantViolationError);
      const violations = (err as LaunchInvariantViolationError).violations;
      expect(violations).toHaveLength(1);
      expect(violations[0].reason).toBe('gap_exceeded');
      expect(violations[0].nextEventType).toBe('task.executor.selected');
      expect(violations[0].gapMs).toBeGreaterThan(60_000);
    }
  });

  it('honours options.taskIds to restrict the scan', () => {
    const persistence = buildPersistence({
      'task-orphan': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
      ],
      'task-ok': [
        { id: 1, eventType: 'task.launch_claimed', payload: undefined, createdAt: T0 },
        { id: 2, eventType: 'task.running', payload: undefined, createdAt: T1 },
      ],
    });

    const result = assertLaunchInvariant(persistence, {
      maxGapMs: 5_000,
      taskIds: ['task-ok'],
    });

    expect(result.taskCount).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it('exposes a default maxGapMs anchored to the dispatch lease budget', () => {
    expect(DEFAULT_LAUNCH_INVARIANT_MAX_GAP_MS).toBe(
      DISPATCH_LEASE_MS * DISPATCH_MAX_ATTEMPTS + 30_000,
    );
  });
});

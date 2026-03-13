import { describe, it, expect } from 'vitest';
import { TaskScheduler } from '../scheduler.js';

describe('TaskScheduler', () => {
  describe('enqueue', () => {
    it('adds jobs sorted by priority (high first)', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'low', priority: 1 });
      scheduler.enqueue({ taskId: 'high', priority: 10 });
      scheduler.enqueue({ taskId: 'mid', priority: 5 });

      // Dequeue order should be high → mid → low.
      expect(scheduler.dequeue()!.taskId).toBe('high');
      expect(scheduler.dequeue()!.taskId).toBe('mid');
      expect(scheduler.dequeue()!.taskId).toBe('low');
    });
  });

  describe('dequeue', () => {
    it('returns the highest priority job', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'a', priority: 3 });
      scheduler.enqueue({ taskId: 'b', priority: 7 });

      const job = scheduler.dequeue();
      expect(job).not.toBeNull();
      expect(job!.taskId).toBe('b');
      expect(job!.priority).toBe(7);
    });

    it('respects maxWorkers limit (returns null when at capacity)', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      // Fill both worker slots.
      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();

      // Third dequeue should return null — at capacity.
      expect(scheduler.dequeue()).toBeNull();
    });

    it('returns null when queue is empty', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.dequeue()).toBeNull();
    });
  });

  describe('completeJob', () => {
    it('frees capacity, allows next dequeue', () => {
      const scheduler = new TaskScheduler(1);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });

      // Fill the single worker slot.
      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('b');

      // At capacity — dequeue blocked.
      expect(scheduler.dequeue()).toBeNull();

      // Complete the running job.
      scheduler.completeJob('b');

      // Now the next job can be dequeued.
      const second = scheduler.dequeue();
      expect(second).not.toBeNull();
      expect(second!.taskId).toBe('a');
    });
  });

  describe('killAll', () => {
    it('clears queue and running set, returns counts', () => {
      const scheduler = new TaskScheduler(4);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      // Move two into running state.
      scheduler.dequeue();
      scheduler.dequeue();

      // 2 running, 1 queued.
      const result = scheduler.killAll();
      expect(result.killedCount).toBe(2);
      expect(result.clearedCount).toBe(1);

      // Everything is empty now.
      const status = scheduler.getStatus();
      expect(status.queueLength).toBe(0);
      expect(status.runningCount).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns correct counts', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      scheduler.dequeue(); // 'c' moves to running

      const status = scheduler.getStatus();
      expect(status.queueLength).toBe(2);
      expect(status.runningCount).toBe(1);
      expect(status.maxWorkers).toBe(3);
    });
  });

  describe('isRunning', () => {
    it('returns true for running tasks, false otherwise', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'x', priority: 5 });
      expect(scheduler.isRunning('x')).toBe(false);

      scheduler.dequeue();
      expect(scheduler.isRunning('x')).toBe(true);

      scheduler.completeJob('x');
      expect(scheduler.isRunning('x')).toBe(false);
    });
  });

  describe('weight-based scheduling', () => {
    it('respects weight budget: heavy task blocks others', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'heavy', priority: 5, weight: 3 });
      scheduler.enqueue({ taskId: 'light', priority: 1, weight: 1 });

      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('heavy');

      // Budget exhausted (3/3), light task cannot start
      expect(scheduler.dequeue()).toBeNull();
    });

    it('allows multiple light tasks within budget', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1, weight: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1, weight: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1, weight: 1 });
      scheduler.enqueue({ taskId: 'd', priority: 1, weight: 1 });

      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
      // Budget full (3/3)
      expect(scheduler.dequeue()).toBeNull();
    });

    it('skips heavy job to fit lighter one when budget is tight', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'heavy', priority: 10, weight: 3 });
      scheduler.enqueue({ taskId: 'light', priority: 1, weight: 1 });

      // Start the light one first (weight 1, fits in budget)
      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('heavy'); // heavy has higher priority and fits initially

      // Now 3/3 used, light cannot fit
      expect(scheduler.dequeue()).toBeNull();

      // Complete heavy, now light can run
      scheduler.completeJob('heavy');
      const second = scheduler.dequeue();
      expect(second!.taskId).toBe('light');
    });

    it('picks lower-priority job that fits when high-priority is too heavy', () => {
      const scheduler = new TaskScheduler(3);

      // Start a weight-2 task to leave 1 unit of budget
      scheduler.enqueue({ taskId: 'medium', priority: 5, weight: 2 });
      scheduler.dequeue(); // running weight = 2

      // Queue a heavy (3) and a light (1)
      scheduler.enqueue({ taskId: 'heavy', priority: 10, weight: 3 });
      scheduler.enqueue({ taskId: 'light', priority: 1, weight: 1 });

      // Heavy doesn't fit (2+3=5 > 3), but light does (2+1=3 <= 3)
      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('light');
    });

    it('deadlock prevention: force-starts oversized task when nothing running', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'oversized', priority: 5, weight: 5 });

      // Weight 5 exceeds budget of 2, but nothing is running → force start
      const job = scheduler.dequeue();
      expect(job).not.toBeNull();
      expect(job!.taskId).toBe('oversized');
    });

    it('completeJob frees weight correctly', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1, weight: 2 });
      scheduler.enqueue({ taskId: 'b', priority: 1, weight: 2 });

      scheduler.dequeue(); // a starts, running weight = 2
      expect(scheduler.dequeue()).toBeNull(); // b (2) doesn't fit (2+2=4 > 3)

      scheduler.completeJob('a'); // frees weight 2

      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('b');
    });

    it('weight defaults to 1 when not specified', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1 });

      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
      // 2 default-weight tasks fill budget of 2
      expect(scheduler.dequeue()).toBeNull();
    });

    it('zero-weight tasks do not consume budget', () => {
      const scheduler = new TaskScheduler(1);

      scheduler.enqueue({ taskId: 'real', priority: 1, weight: 1 });
      scheduler.enqueue({ taskId: 'free1', priority: 1, weight: 0 });
      scheduler.enqueue({ taskId: 'free2', priority: 1, weight: 0 });

      // All three should be dequeueable: real (1/1) + two zero-weight
      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
    });

    it('getStatus reports weight info', () => {
      const scheduler = new TaskScheduler(5);

      scheduler.enqueue({ taskId: 'a', priority: 1, weight: 3 });
      scheduler.dequeue();

      const status = scheduler.getStatus();
      expect(status.runningWeight).toBe(3);
      expect(status.maxWeight).toBe(5);
    });

    it('killAll resets weight tracking', () => {
      const scheduler = new TaskScheduler(5);

      scheduler.enqueue({ taskId: 'a', priority: 1, weight: 3 });
      scheduler.dequeue();

      scheduler.killAll();

      const status = scheduler.getStatus();
      expect(status.runningWeight).toBe(0);
      expect(status.runningCount).toBe(0);
    });
  });
});

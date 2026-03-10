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
});

import { describe, it, expect } from 'vitest';
import { TaskScheduler } from '../scheduler.js';

describe('TaskScheduler', () => {
  describe('enqueue', () => {
    it('adds jobs sorted by priority (high first)', () => {
      const scheduler = new TaskScheduler(200);

      scheduler.enqueue({ taskId: 'low', priority: 1, utilization: 10 });
      scheduler.enqueue({ taskId: 'high', priority: 10, utilization: 10 });
      scheduler.enqueue({ taskId: 'mid', priority: 5, utilization: 10 });

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

    it('respects utilization budget (returns null when at capacity)', () => {
      // Default utilization is 50, budget is 100 → fits 2 tasks
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      expect(scheduler.dequeue()).not.toBeNull(); // c: 50/100
      expect(scheduler.dequeue()).not.toBeNull(); // b: 100/100

      // Third dequeue should return null — at capacity
      expect(scheduler.dequeue()).toBeNull();
    });

    it('returns null when queue is empty', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.dequeue()).toBeNull();
    });
  });

  describe('completeJob', () => {
    it('frees capacity, allows next dequeue', () => {
      const scheduler = new TaskScheduler(50);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'b', priority: 2, utilization: 50 });

      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('b');

      expect(scheduler.dequeue()).toBeNull();

      scheduler.completeJob('b');

      const second = scheduler.dequeue();
      expect(second).not.toBeNull();
      expect(second!.taskId).toBe('a');
    });
  });

  describe('killAll', () => {
    it('clears queue and running set, returns counts', () => {
      const scheduler = new TaskScheduler(200);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'b', priority: 2, utilization: 50 });
      scheduler.enqueue({ taskId: 'c', priority: 3, utilization: 50 });

      scheduler.dequeue();
      scheduler.dequeue();

      const result = scheduler.killAll();
      expect(result.killedCount).toBe(2);
      expect(result.clearedCount).toBe(1);

      const status = scheduler.getStatus();
      expect(status.queueLength).toBe(0);
      expect(status.runningCount).toBe(0);
      expect(status.runningUtilization).toBe(0);
    });
  });

  describe('getStatus', () => {
    it('returns correct counts', () => {
      const scheduler = new TaskScheduler(200);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'b', priority: 2, utilization: 50 });
      scheduler.enqueue({ taskId: 'c', priority: 3, utilization: 50 });

      scheduler.dequeue(); // 'c' moves to running

      const status = scheduler.getStatus();
      expect(status.queueLength).toBe(2);
      expect(status.runningCount).toBe(1);
      expect(status.maxUtilization).toBe(200);
      expect(status.runningUtilization).toBe(50);
      expect(status.maxWorkers).toBe(200);
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

  describe('utilization-based scheduling', () => {
    it('respects utilization budget: exclusive task blocks others', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'exclusive', priority: 5, utilization: 100 });
      scheduler.enqueue({ taskId: 'light', priority: 1, utilization: 10 });

      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('exclusive');

      // Budget exhausted (100/100), light task cannot start
      expect(scheduler.dequeue()).toBeNull();
    });

    it('allows multiple light tasks within budget', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 25 });
      scheduler.enqueue({ taskId: 'b', priority: 1, utilization: 25 });
      scheduler.enqueue({ taskId: 'c', priority: 1, utilization: 25 });
      scheduler.enqueue({ taskId: 'd', priority: 1, utilization: 25 });
      scheduler.enqueue({ taskId: 'e', priority: 1, utilization: 25 });

      expect(scheduler.dequeue()).not.toBeNull(); // 25/100
      expect(scheduler.dequeue()).not.toBeNull(); // 50/100
      expect(scheduler.dequeue()).not.toBeNull(); // 75/100
      expect(scheduler.dequeue()).not.toBeNull(); // 100/100
      // Budget full
      expect(scheduler.dequeue()).toBeNull();
    });

    it('picks lower-priority job that fits when high-priority is too heavy', () => {
      const scheduler = new TaskScheduler(100);

      // Start a utilization-60 task to leave 40 remaining
      scheduler.enqueue({ taskId: 'medium', priority: 5, utilization: 60 });
      scheduler.dequeue(); // running utilization = 60

      // Queue a heavy (80) and a light (30)
      scheduler.enqueue({ taskId: 'heavy', priority: 10, utilization: 80 });
      scheduler.enqueue({ taskId: 'light', priority: 1, utilization: 30 });

      // Heavy doesn't fit (60+80=140 > 100), but light does (60+30=90 <= 100)
      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('light');
    });

    it('deadlock prevention: force-starts oversized task when nothing running', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'oversized', priority: 5, utilization: 200 });

      // Utilization 200 exceeds budget of 100, but nothing is running → force start
      const job = scheduler.dequeue();
      expect(job).not.toBeNull();
      expect(job!.taskId).toBe('oversized');
    });

    it('completeJob frees utilization correctly', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 70 });
      scheduler.enqueue({ taskId: 'b', priority: 1, utilization: 70 });

      scheduler.dequeue(); // a starts, running utilization = 70
      expect(scheduler.dequeue()).toBeNull(); // b (70) doesn't fit (70+70=140 > 100)

      scheduler.completeJob('a'); // frees 70

      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('b');
    });

    it('default utilization is 50 when not specified', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1 });

      expect(scheduler.dequeue()).not.toBeNull(); // 50/100
      expect(scheduler.dequeue()).not.toBeNull(); // 100/100
      // 2 default-utilization tasks fill budget of 100
      expect(scheduler.dequeue()).toBeNull();
    });

    it('zero-utilization tasks do not consume budget', () => {
      const scheduler = new TaskScheduler(50);

      scheduler.enqueue({ taskId: 'real', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'free1', priority: 1, utilization: 0 });
      scheduler.enqueue({ taskId: 'free2', priority: 1, utilization: 0 });

      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
      expect(scheduler.dequeue()).not.toBeNull();
    });

    it('getStatus reports utilization info', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 60 });
      scheduler.dequeue();

      const status = scheduler.getStatus();
      expect(status.runningUtilization).toBe(60);
      expect(status.maxUtilization).toBe(100);
    });

    it('killAll resets utilization tracking', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 60 });
      scheduler.dequeue();

      scheduler.killAll();

      const status = scheduler.getStatus();
      expect(status.runningUtilization).toBe(0);
      expect(status.runningCount).toBe(0);
    });

    it('getRunningTaskIds returns current running set', () => {
      const scheduler = new TaskScheduler(200);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'b', priority: 2, utilization: 50 });
      scheduler.enqueue({ taskId: 'c', priority: 3, utilization: 50 });

      expect(scheduler.getRunningTaskIds()).toEqual([]);

      scheduler.dequeue(); // c
      scheduler.dequeue(); // b
      expect(scheduler.getRunningTaskIds().sort()).toEqual(['b', 'c']);

      scheduler.completeJob('c');
      expect(scheduler.getRunningTaskIds()).toEqual(['b']);
    });

    it('completeJob on non-running task is a no-op', () => {
      const scheduler = new TaskScheduler(100);
      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.dequeue();

      scheduler.completeJob('unknown');
      expect(scheduler.getStatus().runningCount).toBe(1);
      expect(scheduler.getStatus().runningUtilization).toBe(50);
    });

    it('runningUtilization inflates when completeJob is never called (proves the leak)', () => {
      const scheduler = new TaskScheduler(100);

      scheduler.enqueue({ taskId: 'a', priority: 1, utilization: 50 });
      scheduler.enqueue({ taskId: 'b', priority: 2, utilization: 50 });
      scheduler.enqueue({ taskId: 'c', priority: 3, utilization: 50 });

      scheduler.dequeue(); // c: 50/100
      scheduler.dequeue(); // b: 100/100

      // Without completeJob, capacity stays full — new task can't start
      expect(scheduler.dequeue()).toBeNull();
      expect(scheduler.getStatus().runningUtilization).toBe(100);
      expect(scheduler.getStatus().runningCount).toBe(2);

      // After completing one, capacity opens
      scheduler.completeJob('c');
      expect(scheduler.dequeue()).not.toBeNull();
    });

    it('UTILIZATION_MAX blocks everything when running', () => {
      const UTILIZATION_MAX = 2147483647;
      const scheduler = new TaskScheduler(100);

      // When only an exclusive task is queued, deadlock prevention force-starts it
      scheduler.enqueue({ taskId: 'exclusive', priority: 5, utilization: UTILIZATION_MAX });

      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('exclusive');

      // While exclusive is running, nothing else can start
      scheduler.enqueue({ taskId: 'normal', priority: 1, utilization: 50 });
      expect(scheduler.dequeue()).toBeNull();

      // After exclusive completes, normal can run
      scheduler.completeJob('exclusive');
      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('normal');
    });
  });
});

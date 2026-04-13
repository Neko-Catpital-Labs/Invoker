import { describe, it, expect } from 'vitest';
import { TaskScheduler } from '../scheduler.js';

describe('TaskScheduler', () => {
  describe('enqueue', () => {
    it('adds jobs sorted by priority (high first)', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'low', attemptId: 'low-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'high', attemptId: 'high-a1', priority: 10 });
      scheduler.enqueue({ taskId: 'mid', attemptId: 'mid-a1', priority: 5 });

      expect(scheduler.dequeue()!.taskId).toBe('high');
      expect(scheduler.dequeue()!.taskId).toBe('mid');
      expect(scheduler.dequeue()!.taskId).toBe('low');
    });
  });

  describe('dequeue', () => {
    it('returns the highest priority job', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 3 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 7 });

      const job = scheduler.dequeue();
      expect(job).not.toBeNull();
      expect(job!.taskId).toBe('b');
      expect(job!.attemptId).toBe('b-a1');
      expect(job!.priority).toBe(7);
    });

    it('respects maxConcurrency limit (returns null when at capacity)', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      expect(scheduler.dequeue()).not.toBeNull(); // c starts (1/2)
      expect(scheduler.dequeue()).not.toBeNull(); // b starts (2/2)

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
      const scheduler = new TaskScheduler(1);

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      const first = scheduler.dequeue();
      expect(first!.taskId).toBe('b');
      expect(first!.attemptId).toBe('b-a1');

      expect(scheduler.dequeue()).toBeNull();

      scheduler.completeJob('b-a1');

      const second = scheduler.dequeue();
      expect(second).not.toBeNull();
      expect(second!.taskId).toBe('a');
    });
  });

  describe('killAll', () => {
    it('clears queue and running set, returns counts', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      scheduler.dequeue();
      scheduler.dequeue();

      const result = scheduler.killAll();
      expect(result.killedCount).toBe(2);
      expect(result.clearedCount).toBe(1);

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
      expect(status.maxConcurrency).toBe(3);
    });
  });

  describe('isRunning', () => {
    it('returns true for running tasks, false otherwise', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'x', attemptId: 'x-a1', priority: 5 });
      expect(scheduler.isRunning('x')).toBe(false);

      scheduler.dequeue();
      expect(scheduler.isRunning('x')).toBe(true);
      expect(scheduler.isRunning('x-a1')).toBe(true);

      scheduler.completeJob('x-a1');
      expect(scheduler.isRunning('x')).toBe(false);
    });
  });

  describe('attemptId support', () => {
    it('tracks running jobs by attemptId while preserving taskId compatibility', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'task-a', attemptId: 'task-a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'task-a', attemptId: 'task-a-a2', priority: 2 });

      const first = scheduler.dequeue();
      const second = scheduler.dequeue();

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(first!.attemptId).toBe('task-a-a2');
      expect(second!.attemptId).toBe('task-a-a1');
      expect(scheduler.getRunningAttemptIds().sort()).toEqual(['task-a-a1', 'task-a-a2']);
      expect(scheduler.getRunningTaskIds()).toEqual(['task-a']);
      expect(scheduler.isRunning('task-a')).toBe(true);
      expect(scheduler.isRunning('task-a-a1')).toBe(true);

      scheduler.completeJob('task-a-a2');

      expect(scheduler.getRunningAttemptIds()).toEqual(['task-a-a1']);
      expect(scheduler.isRunning('task-a-a2')).toBe(false);
      expect(scheduler.isRunning('task-a')).toBe(true);
    });
  });

  describe('maxConcurrency-based scheduling', () => {
    it('allows up to maxConcurrency tasks to run', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1 });
      scheduler.enqueue({ taskId: 'd', priority: 1 });

      expect(scheduler.dequeue()).not.toBeNull(); // 1/3
      expect(scheduler.dequeue()).not.toBeNull(); // 2/3
      expect(scheduler.dequeue()).not.toBeNull(); // 3/3
      // At capacity
      expect(scheduler.dequeue()).toBeNull();
    });

    it('completeJob frees slot correctly', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1 });

      scheduler.dequeue(); // a starts (1/2)
      scheduler.dequeue(); // b starts (2/2)
      expect(scheduler.dequeue()).toBeNull(); // c blocked

      scheduler.completeJob('a'); // frees slot (1/2)

      const next = scheduler.dequeue();
      expect(next!.taskId).toBe('c');
    });

    it('getRunningTaskIds returns current running set', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });
      scheduler.enqueue({ taskId: 'c', attemptId: 'c-a1', priority: 3 });

      expect(scheduler.getRunningTaskIds()).toEqual([]);

      scheduler.dequeue(); // c
      scheduler.dequeue(); // b
      expect(scheduler.getRunningTaskIds().sort()).toEqual(['b', 'c']);

      scheduler.completeJob('c');
      expect(scheduler.getRunningTaskIds()).toEqual(['b']);
    });

    it('completeJob on non-running task is a no-op', () => {
      const scheduler = new TaskScheduler(3);
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.dequeue();

      scheduler.completeJob('unknown');
      expect(scheduler.getStatus().runningCount).toBe(1);
    });

    it('runningCount increases correctly without completeJob', () => {
      const scheduler = new TaskScheduler(2);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      scheduler.dequeue(); // c: 1/2
      scheduler.dequeue(); // b: 2/2

      // Without completeJob, capacity stays full
      expect(scheduler.dequeue()).toBeNull();
      expect(scheduler.getStatus().runningCount).toBe(2);

      // After completing one, capacity opens
      scheduler.completeJob('c');
      expect(scheduler.dequeue()).not.toBeNull();
    });
  });

  describe('getQueuedJobs', () => {
    it('returns empty array when queue is empty', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.getQueuedJobs()).toEqual([]);
    });

    it('returns queued (not-yet-dequeued) jobs in priority order', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'low', priority: 1 });
      scheduler.enqueue({ taskId: 'high', priority: 10 });
      scheduler.enqueue({ taskId: 'mid', priority: 5 });

      // Dequeue the highest priority job ('high')
      scheduler.dequeue();

      const queued = scheduler.getQueuedJobs();
      expect(queued).toHaveLength(2);
      expect(queued[0].taskId).toBe('mid');
      expect(queued[1].taskId).toBe('low');
    });

    it('returns shallow copy (mutating the result does not affect internal queue)', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      const copy = scheduler.getQueuedJobs();
      copy.splice(0, copy.length); // clear the returned array

      // Internal queue should be unaffected
      expect(scheduler.getQueuedJobs()).toHaveLength(2);
    });
  });

  describe('removeJob', () => {
    it('removes a queued job and returns true', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      expect(scheduler.removeJob('a')).toBe(true);
      expect(scheduler.getQueuedJobs().map(j => j.taskId)).toEqual(['b']);
    });

    it('returns false for a job that is already running (dequeued)', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.dequeue(); // 'a' is now running

      expect(scheduler.removeJob('a')).toBe(false);
    });

    it('returns false for an unknown taskId', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.removeJob('nonexistent')).toBe(false);
    });

    it('queue state is correct after removal (remaining jobs unaffected)', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 5 });
      scheduler.enqueue({ taskId: 'c', attemptId: 'c-a1', priority: 10 });

      scheduler.removeJob('b');

      // Remaining queue should still be in priority order: c, a
      const queued = scheduler.getQueuedJobs();
      expect(queued).toHaveLength(2);
      expect(queued[0].taskId).toBe('c');
      expect(queued[1].taskId).toBe('a');

      // Dequeue should work normally
      expect(scheduler.dequeue()!.taskId).toBe('c');
      expect(scheduler.dequeue()!.taskId).toBe('a');
    });
  });

  describe('getRunningJobs', () => {
    it('returns empty array when nothing is running', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.getRunningJobs()).toEqual([]);
    });

    it('returns running tasks after dequeue', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      scheduler.dequeue(); // b
      scheduler.dequeue(); // a

      const running = scheduler.getRunningJobs();
      expect(running).toHaveLength(2);

      const taskIds = running.map(j => j.taskId).sort();
      expect(taskIds).toEqual(['a', 'b']);
    });

    it('correctly reports tasks after completeJob', () => {
      const scheduler = new TaskScheduler(3);

      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      scheduler.dequeue(); // b
      scheduler.dequeue(); // a

      scheduler.completeJob('b');

      const running = scheduler.getRunningJobs();
      expect(running).toHaveLength(1);
      expect(running[0].taskId).toBe('a');
    });
  });
});

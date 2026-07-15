import { describe, it, expect } from 'vitest';
import { TaskScheduler } from '../scheduler.js';

/**
 * CC.3: the scheduler is now a pure priority queue. Occupancy /
 * concurrency / completion tracking moved to the durable
 * `task_launch_dispatch` outbox + LaunchDispatcher (Phase B). These
 * tests cover only the surface the orchestrator still relies on:
 * `enqueue`, `takeNext`, `getQueuedJobs`, `removeJob`, `clearQueue`,
 * and `getStatus`.
 */
describe('TaskScheduler', () => {
  describe('enqueue', () => {
    it('adds jobs sorted by priority (high first)', () => {
      const scheduler = new TaskScheduler();

      scheduler.enqueue({ taskId: 'low', attemptId: 'low-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'high', attemptId: 'high-a1', priority: 10 });
      scheduler.enqueue({ taskId: 'mid', attemptId: 'mid-a1', priority: 5 });

      expect(scheduler.takeNext()!.taskId).toBe('high');
      expect(scheduler.takeNext()!.taskId).toBe('mid');
      expect(scheduler.takeNext()!.taskId).toBe('low');
    });

    it('stable ordering for equal priorities (FIFO within priority)', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 1 });
      scheduler.enqueue({ taskId: 'c', priority: 1 });
      expect(scheduler.takeNext()!.taskId).toBe('a');
      expect(scheduler.takeNext()!.taskId).toBe('b');
      expect(scheduler.takeNext()!.taskId).toBe('c');
    });
  });

  describe('takeNext', () => {
    it('returns the highest priority job and removes it', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 3 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 7 });

      const job = scheduler.takeNext();
      expect(job).not.toBeNull();
      expect(job!.taskId).toBe('b');
      expect(job!.attemptId).toBe('b-a1');
      expect(job!.priority).toBe(7);
    });

    it('returns null when queue is empty', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.takeNext()).toBeNull();
    });

    it('does not impose any maxConcurrency limit (gate moved to the outbox)', () => {
      const scheduler = new TaskScheduler(2);
      for (let i = 0; i < 10; i += 1) {
        scheduler.enqueue({ taskId: `t${i}`, priority: i });
      }
      // takeNext keeps draining regardless of constructor's
      // maxConcurrency; that argument is reported in getStatus() for
      // observability but no longer gates dispatch.
      for (let i = 0; i < 10; i += 1) {
        expect(scheduler.takeNext()).not.toBeNull();
      }
      expect(scheduler.takeNext()).toBeNull();
    });
  });

  describe('getQueuedJobs', () => {
    it('returns empty array when queue is empty', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.getQueuedJobs()).toEqual([]);
    });

    it('returns queued jobs in priority order', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'low', priority: 1 });
      scheduler.enqueue({ taskId: 'high', priority: 10 });
      scheduler.enqueue({ taskId: 'mid', priority: 5 });

      const queued = scheduler.getQueuedJobs();
      expect(queued).toHaveLength(3);
      expect(queued[0].taskId).toBe('high');
      expect(queued[1].taskId).toBe('mid');
      expect(queued[2].taskId).toBe('low');
    });

    it('returns a shallow copy (mutating result does not affect internal queue)', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      const copy = scheduler.getQueuedJobs();
      copy.splice(0, copy.length);

      expect(scheduler.getQueuedJobs()).toHaveLength(2);
    });
  });
  describe('replaceQueue', () => {
    it('replaces the queue with the provided ordering verbatim', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'old', priority: 10 });

      scheduler.replaceQueue([
        { taskId: 'first', attemptId: 'first-a1', priority: 0 },
        { taskId: 'second', attemptId: 'second-a1', priority: 100, bypassLocalDependencyReadiness: true },
      ]);

      expect(scheduler.getQueuedJobs()).toEqual([
        { taskId: 'first', attemptId: 'first-a1', priority: 0 },
        { taskId: 'second', attemptId: 'second-a1', priority: 100, bypassLocalDependencyReadiness: true },
      ]);
      expect(scheduler.takeNext()?.taskId).toBe('first');
      expect(scheduler.takeNext()?.taskId).toBe('second');
    });
  });

  describe('removeJob', () => {
    it('removes a queued job and returns true', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      scheduler.enqueue({ taskId: 'b', attemptId: 'b-a1', priority: 2 });

      expect(scheduler.removeJob('a')).toBe(true);
      expect(scheduler.getQueuedJobs().map((j) => j.taskId)).toEqual(['b']);
    });

    it('matches by attemptId as well as taskId', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', attemptId: 'a-a1', priority: 1 });
      expect(scheduler.removeJob('a-a1')).toBe(true);
      expect(scheduler.getQueuedJobs()).toHaveLength(0);
    });

    it('returns false for an unknown taskId', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.removeJob('nonexistent')).toBe(false);
    });

    it('preserves remaining priority order after removal', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 5 });
      scheduler.enqueue({ taskId: 'c', priority: 10 });

      scheduler.removeJob('b');

      const queued = scheduler.getQueuedJobs();
      expect(queued.map((j) => j.taskId)).toEqual(['c', 'a']);
    });
  });

  describe('clearQueue', () => {
    it('drops every queued job and reports the count', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      expect(scheduler.clearQueue()).toEqual({ clearedCount: 3 });
      expect(scheduler.getQueuedJobs()).toEqual([]);
      expect(scheduler.getStatus().queueLength).toBe(0);
    });

    it('is a no-op on an empty queue', () => {
      const scheduler = new TaskScheduler();
      expect(scheduler.clearQueue()).toEqual({ clearedCount: 0 });
    });
  });

  describe('getStatus', () => {
    it('reports the queue length and the (now-informational) maxConcurrency', () => {
      const scheduler = new TaskScheduler(7);
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });

      const status = scheduler.getStatus();
      expect(status.queueLength).toBe(2);
      expect(status.maxConcurrency).toBe(7);
    });

    it('queueLength updates after takeNext / removeJob / clearQueue', () => {
      const scheduler = new TaskScheduler();
      scheduler.enqueue({ taskId: 'a', priority: 1 });
      scheduler.enqueue({ taskId: 'b', priority: 2 });
      scheduler.enqueue({ taskId: 'c', priority: 3 });

      expect(scheduler.getStatus().queueLength).toBe(3);
      scheduler.takeNext();
      expect(scheduler.getStatus().queueLength).toBe(2);
      scheduler.removeJob('a');
      expect(scheduler.getStatus().queueLength).toBe(1);
      scheduler.clearQueue();
      expect(scheduler.getStatus().queueLength).toBe(0);
    });
  });
});

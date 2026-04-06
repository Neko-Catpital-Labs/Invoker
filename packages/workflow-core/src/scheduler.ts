/**
 * Priority queue with simple maxConcurrency limit for task scheduling.
 *
 * No I/O, no Docker, no Git — just a sorted queue and concurrency tracking.
 * Higher priority numbers are dequeued first.
 */

export interface TaskJob {
  taskId: string;
  priority: number;
}

export class TaskScheduler {
  private queue: TaskJob[] = [];
  private running: Set<string> = new Set();
  private maxConcurrency: number;

  constructor(maxConcurrency: number = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  /** Add a job to the queue, sorted by priority (high first). */
  enqueue(job: TaskJob): void {
    let low = 0;
    let high = this.queue.length;

    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.queue[mid].priority >= job.priority) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    this.queue.splice(low, 0, job);
  }

  /**
   * Remove and return the highest-priority job if under maxConcurrency limit.
   * Returns null if at capacity or queue empty.
   */
  dequeue(): TaskJob | null {
    if (this.queue.length === 0) {
      return null;
    }

    if (this.running.size < this.maxConcurrency) {
      const job = this.queue.shift()!;
      this.running.add(job.taskId);
      return job;
    }

    return null;
  }

  /** Mark a job as complete, freeing its slot. */
  completeJob(taskId: string): void {
    this.running.delete(taskId);
  }

  /** Kill all running jobs and clear the queue. */
  killAll(): { killedCount: number; clearedCount: number } {
    const killedCount = this.running.size;
    const clearedCount = this.queue.length;
    this.running.clear();
    this.queue = [];
    return { killedCount, clearedCount };
  }

  /** Get current status. */
  getStatus(): { queueLength: number; runningCount: number; maxConcurrency: number } {
    return {
      queueLength: this.queue.length,
      runningCount: this.running.size,
      maxConcurrency: this.maxConcurrency,
    };
  }

  /** Check if a task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }

  /** Return all task IDs currently in the running set. */
  getRunningTaskIds(): string[] {
    return Array.from(this.running);
  }

  /** Return a shallow copy of the internal queue (not-yet-running jobs). */
  getQueuedJobs(): TaskJob[] {
    return [...this.queue];
  }

  /** Find and remove a job from the queue by taskId. Returns true if found and removed, false otherwise. */
  removeJob(taskId: string): boolean {
    const index = this.queue.findIndex(job => job.taskId === taskId);
    if (index === -1) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  /** Return running tasks (without utilization info). */
  getRunningJobs(): Array<{ taskId: string }> {
    return Array.from(this.running).map(taskId => ({ taskId }));
  }
}

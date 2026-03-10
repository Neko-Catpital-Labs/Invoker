/**
 * Pure priority queue with concurrency control for task scheduling.
 *
 * No I/O, no Docker, no Git — just a sorted queue and worker-slot tracking.
 * Higher priority numbers are dequeued first.
 */

export interface TaskJob {
  taskId: string;
  priority: number; // Higher = more important
}

export class TaskScheduler {
  private queue: TaskJob[] = [];
  private running: Set<string> = new Set();
  private maxWorkers: number;

  constructor(maxWorkers: number = 4) {
    this.maxWorkers = maxWorkers;
  }

  /** Add a job to the queue, sorted by priority (high first). */
  enqueue(job: TaskJob): void {
    // Binary search for insertion point to keep descending order.
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

  /** Remove and return the highest priority job if capacity allows. Returns null if at capacity or queue empty. */
  dequeue(): TaskJob | null {
    if (this.running.size >= this.maxWorkers) {
      return null;
    }

    if (this.queue.length === 0) {
      return null;
    }

    const job = this.queue.shift()!;
    this.running.add(job.taskId);
    return job;
  }

  /** Mark a job as complete, freeing a worker slot. */
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
  getStatus(): { queueLength: number; runningCount: number; maxWorkers: number } {
    return {
      queueLength: this.queue.length,
      runningCount: this.running.size,
      maxWorkers: this.maxWorkers,
    };
  }

  /** Check if a task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }
}

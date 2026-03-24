/**
 * Priority queue with utilization-based resource budgeting for task scheduling.
 *
 * No I/O, no Docker, no Git — just a sorted queue and resource tracking.
 * Higher priority numbers are dequeued first. Each job carries a utilization
 * value (0-100 or UTILIZATION_MAX); the scheduler only dequeues when the
 * running utilization budget allows.
 */

export interface TaskJob {
  taskId: string;
  priority: number;
  utilization?: number; // 0-100 or UTILIZATION_MAX. Default: 50.
}

const DEFAULT_UTILIZATION = 50;

export class TaskScheduler {
  private queue: TaskJob[] = [];
  private running: Set<string> = new Set();
  private taskUtilizations = new Map<string, number>();
  private runningUtilization = 0;
  private maxUtilization: number;

  constructor(maxUtilization: number = 100) {
    this.maxUtilization = maxUtilization;
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
   * Remove and return the highest-priority job that fits within the
   * remaining utilization budget. Returns null if at capacity or queue empty.
   *
   * Deadlock prevention: if nothing fits but nothing is running,
   * force-start the highest-priority job regardless of utilization.
   */
  dequeue(): TaskJob | null {
    if (this.queue.length === 0) {
      return null;
    }

    for (let i = 0; i < this.queue.length; i++) {
      const u = this.queue[i].utilization ?? DEFAULT_UTILIZATION;
      if (this.runningUtilization + u <= this.maxUtilization) {
        const job = this.queue.splice(i, 1)[0];
        this.startJob(job);
        return job;
      }
    }

    if (this.running.size === 0) {
      const job = this.queue.shift()!;
      this.startJob(job);
      return job;
    }

    return null;
  }

  private startJob(job: TaskJob): void {
    const u = job.utilization ?? DEFAULT_UTILIZATION;
    this.running.add(job.taskId);
    this.taskUtilizations.set(job.taskId, u);
    this.runningUtilization += u;
  }

  /** Mark a job as complete, freeing its utilization. */
  completeJob(taskId: string): void {
    this.running.delete(taskId);
    const u = this.taskUtilizations.get(taskId) ?? 0;
    this.runningUtilization -= u;
    this.taskUtilizations.delete(taskId);
  }

  /** Kill all running jobs and clear the queue. */
  killAll(): { killedCount: number; clearedCount: number } {
    const killedCount = this.running.size;
    const clearedCount = this.queue.length;
    this.running.clear();
    this.taskUtilizations.clear();
    this.runningUtilization = 0;
    this.queue = [];
    return { killedCount, clearedCount };
  }

  /** Get current status. */
  getStatus(): { queueLength: number; runningCount: number; maxWorkers: number; runningUtilization: number; maxUtilization: number } {
    return {
      queueLength: this.queue.length,
      runningCount: this.running.size,
      maxWorkers: this.maxUtilization,
      runningUtilization: this.runningUtilization,
      maxUtilization: this.maxUtilization,
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

  /** Return running tasks with their utilization values. */
  getRunningJobs(): Array<{ taskId: string; utilization: number }> {
    return Array.from(this.running).map(taskId => ({
      taskId,
      utilization: this.taskUtilizations.get(taskId) ?? 0,
    }));
  }
}

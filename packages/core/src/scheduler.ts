/**
 * Priority queue with weight-based resource budgeting for task scheduling.
 *
 * No I/O, no Docker, no Git — just a sorted queue and resource tracking.
 * Higher priority numbers are dequeued first. Each job carries a resource
 * weight; the scheduler only dequeues when the running weight budget allows.
 */

export interface TaskJob {
  taskId: string;
  priority: number;
  weight?: number; // Resource weight (default: 1). Higher = heavier.
}

export class TaskScheduler {
  private queue: TaskJob[] = [];
  private running: Set<string> = new Set();
  private taskWeights = new Map<string, number>();
  private runningWeight = 0;
  private maxWeight: number;

  constructor(maxWeight: number = 4) {
    this.maxWeight = maxWeight;
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
   * remaining weight budget. Returns null if at capacity or queue empty.
   *
   * Deadlock prevention: if nothing fits but nothing is running,
   * force-start the highest-priority job regardless of weight.
   */
  dequeue(): TaskJob | null {
    if (this.queue.length === 0) {
      return null;
    }

    for (let i = 0; i < this.queue.length; i++) {
      const w = this.queue[i].weight ?? 1;
      if (this.runningWeight + w <= this.maxWeight) {
        const job = this.queue.splice(i, 1)[0];
        this.startJob(job);
        return job;
      }
    }

    // Deadlock prevention: if nothing is running, force-start the first job
    if (this.running.size === 0) {
      const job = this.queue.shift()!;
      this.startJob(job);
      return job;
    }

    return null;
  }

  private startJob(job: TaskJob): void {
    const w = job.weight ?? 1;
    this.running.add(job.taskId);
    this.taskWeights.set(job.taskId, w);
    this.runningWeight += w;
  }

  /** Mark a job as complete, freeing its resource weight. */
  completeJob(taskId: string): void {
    this.running.delete(taskId);
    const w = this.taskWeights.get(taskId) ?? 0;
    this.runningWeight -= w;
    this.taskWeights.delete(taskId);
  }

  /** Kill all running jobs and clear the queue. */
  killAll(): { killedCount: number; clearedCount: number } {
    const killedCount = this.running.size;
    const clearedCount = this.queue.length;
    this.running.clear();
    this.taskWeights.clear();
    this.runningWeight = 0;
    this.queue = [];
    return { killedCount, clearedCount };
  }

  /** Get current status. */
  getStatus(): { queueLength: number; runningCount: number; maxWorkers: number; runningWeight: number; maxWeight: number } {
    return {
      queueLength: this.queue.length,
      runningCount: this.running.size,
      maxWorkers: this.maxWeight,
      maxWeight: this.maxWeight,
      runningWeight: this.runningWeight,
    };
  }

  /** Check if a task is currently running. */
  isRunning(taskId: string): boolean {
    return this.running.has(taskId);
  }
}

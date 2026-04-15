/**
 * Priority queue with simple maxConcurrency limit for task scheduling.
 *
 * No I/O, no Docker, no Git — just a sorted queue and concurrency tracking.
 * Higher priority numbers are dequeued first.
 */

export interface TaskJob {
  taskId: string;
  attemptId?: string;
  priority: number;
}

interface RunningJob {
  taskId: string;
  attemptId: string;
}

export class TaskScheduler {
  private queue: TaskJob[] = [];
  private running: Map<string, RunningJob> = new Map();
  private runningByTaskId: Map<string, Set<string>> = new Map();
  private maxConcurrency: number;

  constructor(maxConcurrency: number = 3) {
    this.maxConcurrency = maxConcurrency;
  }

  private getJobKey(job: TaskJob): string {
    return job.attemptId ?? job.taskId;
  }

  private addRunning(job: TaskJob): void {
    const attemptId = this.getJobKey(job);
    const runningJob: RunningJob = {
      taskId: job.taskId,
      attemptId,
    };

    this.running.set(attemptId, runningJob);

    const taskIds = this.runningByTaskId.get(job.taskId) ?? new Set<string>();
    taskIds.add(attemptId);
    this.runningByTaskId.set(job.taskId, taskIds);
  }

  private removeRunningAttempt(attemptId: string): boolean {
    const runningJob = this.running.get(attemptId);
    if (!runningJob) {
      return false;
    }

    this.running.delete(attemptId);
    const taskIds = this.runningByTaskId.get(runningJob.taskId);
    if (taskIds) {
      taskIds.delete(attemptId);
      if (taskIds.size === 0) {
        this.runningByTaskId.delete(runningJob.taskId);
      }
    }

    return true;
  }

  private removeRunningTask(taskId: string): number {
    const attemptIds = this.runningByTaskId.get(taskId);
    if (!attemptIds || attemptIds.size === 0) {
      return 0;
    }

    let removed = 0;
    for (const attemptId of attemptIds) {
      if (this.removeRunningAttempt(attemptId)) {
        removed += 1;
      }
    }
    return removed;
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
   * Remove and return the next queued job without mutating the running set.
   *
   * Orchestrator uses this when persisted attempt leases, not in-memory state,
   * are the source of truth for occupancy.
   */
  takeNext(): TaskJob | null {
    if (this.queue.length === 0) {
      return null;
    }
    return this.queue.shift() ?? null;
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
      this.addRunning(job);
      return {
        ...job,
        attemptId: this.getJobKey(job),
      };
    }

    return null;
  }

  /** Mark a job as complete, freeing its slot. */
  completeJob(taskIdOrAttemptId: string): void {
    if (this.removeRunningAttempt(taskIdOrAttemptId)) {
      return;
    }

    this.removeRunningTask(taskIdOrAttemptId);
  }

  /** Kill all running jobs and clear the queue. */
  killAll(): { killedCount: number; clearedCount: number } {
    const killedCount = this.running.size;
    const clearedCount = this.queue.length;
    this.running.clear();
    this.runningByTaskId.clear();
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
  isRunning(taskIdOrAttemptId: string): boolean {
    return this.running.has(taskIdOrAttemptId) || this.runningByTaskId.has(taskIdOrAttemptId);
  }

  /** Return all attempt IDs currently in the running set. */
  getRunningAttemptIds(): string[] {
    return Array.from(this.running.keys());
  }

  /** Return all task IDs currently in the running set. */
  getRunningTaskIds(): string[] {
    const taskIds: string[] = [];
    const seen = new Set<string>();

    for (const runningJob of this.running.values()) {
      if (seen.has(runningJob.taskId)) {
        continue;
      }
      seen.add(runningJob.taskId);
      taskIds.push(runningJob.taskId);
    }

    return taskIds;
  }

  /** Return a shallow copy of the internal queue (not-yet-running jobs). */
  getQueuedJobs(): TaskJob[] {
    return [...this.queue];
  }

  /** Find and remove a job from the queue by taskId. Returns true if found and removed, false otherwise. */
  removeJob(taskIdOrAttemptId: string): boolean {
    const index = this.queue.findIndex(
      job => job.attemptId === taskIdOrAttemptId || job.taskId === taskIdOrAttemptId,
    );
    if (index === -1) {
      return false;
    }
    this.queue.splice(index, 1);
    return true;
  }

  /** Return running jobs with both task and attempt identity. */
  getRunningJobs(): Array<{ taskId: string; attemptId: string }> {
    return Array.from(this.running.values()).map(({ taskId, attemptId }) => ({ taskId, attemptId }));
  }
}

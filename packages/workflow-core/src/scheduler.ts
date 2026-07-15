/**
 * Priority queue for task scheduling.
 *
 * CC.3: this used to also track a `running` Set + `maxConcurrency`
 * gate, but the durable `task_launch_dispatch` outbox is now the
 * single source of truth for occupancy. The scheduler is reduced to
 * a sorted enqueue / takeNext priority queue plus inspection
 * helpers; concurrency is enforced by `claimLaunchDispatchAtomic`
 * in the SQLite adapter.
 *
 * No I/O, no Docker, no Git — just a sorted queue.
 * Higher priority numbers come out first.
 */

export interface TaskJob {
  taskId: string;
  attemptId?: string;
  priority: number;
  // Reserved for replacement-root launches. Normal queued work must pass
  // dependency readiness at dequeue time.
  bypassLocalDependencyReadiness?: boolean;
}

export class TaskScheduler {
  private queue: TaskJob[] = [];

  // The constructor still accepts a `maxConcurrency` argument for
  // backwards compatibility with existing callers (Orchestrator,
  // tests) — it is reported in `getStatus()` for observability but no
  // longer gates dispatch.
  constructor(private readonly maxConcurrency: number = 3) {}

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
   * Remove and return the next queued job.
   *
   * Orchestrator uses this when persisted attempt leases (and, after
   * Phase B, dispatch leases) are the source of truth for occupancy.
   */
  takeNext(): TaskJob | null {
    if (this.queue.length === 0) {
      return null;
    }
    return this.queue.shift() ?? null;
  }

  /**
   * Empty the queue. Returns the number of jobs that were dropped.
   *
   * Used by Orchestrator.removeAllWorkflows / deleteAllWorkflows so a
   * mass delete doesn't leave stale jobs pointing at vanished tasks.
   * The legacy `killAll()` also cleared the in-process running set;
   * with CC.3 that set is gone, so this is just a queue drain.
   */
  clearQueue(): { clearedCount: number } {
    const clearedCount = this.queue.length;
    this.queue = [];
    return { clearedCount };
  }

  /** Get current status. */
  getStatus(): { queueLength: number; maxConcurrency: number } {
    return {
      queueLength: this.queue.length,
      maxConcurrency: this.maxConcurrency,
    };
  }

  replaceQueue(jobs: TaskJob[]): void {
    this.queue = [...jobs];
  }

  /** Return a shallow copy of the internal queue (not-yet-running jobs). */
  getQueuedJobs(): TaskJob[] {
    return [...this.queue];
  }

  /** Find and remove a job from the queue by taskId or attemptId. */
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
}

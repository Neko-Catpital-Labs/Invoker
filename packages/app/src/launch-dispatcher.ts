/**
 * Active dispatcher for the launch-handoff outbox.
 *
 * `drainScheduler` writes ready task attempts into
 * `task_launch_dispatch`; this dispatcher leases those rows and hands
 * them to the TaskRunner. Durable rows let a later poll recover from
 * process exits or missed in-memory handoffs.
 */

import type { SQLiteAdapter, TaskLaunchDispatch } from '@invoker/data-store';
import type { LaunchOutboxAck } from '@invoker/execution-engine';
import type { TaskLaunchReadiness, TaskState } from '@invoker/workflow-core';
import { DISPATCH_MAX_ATTEMPTS, type Logger } from '@invoker/contracts';


export type LaunchDispatcherPersistence = Pick<
  SQLiteAdapter,
  | 'markLaunchDispatchCompleted'
  | 'markLaunchDispatchFailed'
  | 'markLaunchDispatchAbandoned'
  | 'reapExpiredLaunchDispatchLeases'
  | 'listAbandonableLaunchDispatchLeases'
  | 'claimLaunchDispatchAtomic'
  | 'listExecutionResourceLeasesByTask'
  | 'releaseExecutionResourceLease'
  | 'logEvent'
>;

/**
 * Narrow interface for the orchestrator surface the dispatcher needs.
 * Avoids widening the dependency on the whole Orchestrator class.
 * `getTask` is optional because the reaper path (used in observer
 * mode and by tests that only exercise abandon/reap) does not need
 * it; only active-mode dispatch reads it.
 */
export interface LaunchDispatcherOrchestrator {
  prepareTaskForNewAttempt(taskId: string, reason: string): unknown;
  syncFromDb?(workflowId: string): void;
  getTask?(taskId: string): TaskState | undefined;
  getTaskLaunchReadiness?(taskId: string): TaskLaunchReadiness;
}

/**
 * Narrow interface for the TaskRunner surface the dispatcher hands
 * leased rows to. Defined here (rather than `Pick<TaskRunner, ...>`)
 * because @invoker/app already depends on @invoker/execution-engine
 * but we want to keep the surface area minimal and testable.
 */
export interface LaunchDispatcherTaskRunner {
  executeTask(
    task: TaskState,
    dispatchOpts?: { dispatchId: number; launchOutbox: LaunchOutboxAck },
  ): Promise<void>;
}

export interface LaunchDispatcherOptions {
  persistence: LaunchDispatcherPersistence;
  orchestrator?: LaunchDispatcherOrchestrator;
  /**
   * Provider for the current TaskRunner. A function (rather than a
   * direct reference) so that rebuildTaskRunner() in main.ts can
   * swap the runner instance without re-creating the dispatcher.
   * Returning `null` short-circuits the active-mode dispatch loop
   * (logged as a warning).
   */
  taskRunnerProvider?: () => LaunchDispatcherTaskRunner | null;
  ownerId: string;
  logger?: Logger;
  maxAttempts?: number;
  maxLeasesPerPoll?: number;
}


export class LaunchDispatcher {
  private readonly persistence: LaunchDispatcherPersistence;
  private readonly orchestrator?: LaunchDispatcherOrchestrator;
  private readonly taskRunnerProvider?: () => LaunchDispatcherTaskRunner | null;
  private readonly ownerId: string;
  private readonly logger?: Logger;
  private readonly maxAttempts: number;
  private readonly maxLeasesPerPoll: number;

  constructor(options: LaunchDispatcherOptions) {
    this.persistence = options.persistence;
    this.orchestrator = options.orchestrator;
    this.taskRunnerProvider = options.taskRunnerProvider;
    this.ownerId = options.ownerId;
    this.logger = options.logger;
    this.maxAttempts = options.maxAttempts ?? DISPATCH_MAX_ATTEMPTS;
    // Bound a single poll's work so the dispatcher cannot starve other
    // owner-loop ticks; the leftover rows are picked up on the next tick.
    this.maxLeasesPerPoll = options.maxLeasesPerPoll ?? 32;
  }


  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Single dispatcher tick:
   *
   *   1. Reap any leased rows whose dispatch lease expired.
   *   2. Abandon expired rows that exhausted their retry budget.
   *   3. Lease and dispatch enqueued rows.
   */
  poll(): void {
    this.reapExpiredLeases();
    this.abandonStuckLeases();
    this.dispatchActive();
  }

  /**
   * Lease enqueued rows up to the per-poll batch bound and hand each
   * one to the TaskRunner. The TaskRunner complete/fail flow drives the
   * rest of the lifecycle; if the JS promise drops mid-flight, the
   * durable outbox row stays leased until the fixed dispatch
   * crash-recovery TTL expires, then the next poll reclaims it.
   */
  private dispatchActive(): void {
    const runner = this.taskRunnerProvider?.() ?? null;
    if (!runner) {
      this.logger?.warn?.('[launch-dispatcher] without taskRunner — skipping dispatch', {
        ownerId: this.ownerId,
        module: 'launch-dispatcher',
      });
      return;
    }
    let dispatched = 0;
    while (dispatched < this.maxLeasesPerPoll) {
      const leased = this.persistence.claimLaunchDispatchAtomic({
        ownerId: this.ownerId,
      });
      if (!leased) break;
      dispatched += 1;
      let task = this.resolveTaskForDispatch(leased);
      if (!task) {
        this.abandonInvalidDispatch(
          leased,
          `Task ${leased.taskId} missing from orchestrator state at dispatch time`,
          'task_missing',
        );
        continue;
      }
      const readiness = this.orchestrator?.getTaskLaunchReadiness?.(leased.taskId);
      if (readiness) {
        if (!readiness.ready) {
          this.abandonInvalidDispatch(
            leased,
            `Task ${leased.taskId} is no longer launch-ready: ${readiness.reason}`,
            'not_launch_ready',
            { readinessReason: readiness.reason },
          );
          continue;
        }
        task = readiness.task;
      }
      if (!this.dispatchMatchesTask(leased, task)) {
        this.abandonInvalidDispatch(
          leased,
          `Launch dispatch ${leased.id} is stale: selected attempt or generation changed`,
          'selected_attempt_changed',
          {
            selectedAttemptId: task.execution.selectedAttemptId,
            selectedGeneration: task.execution.generation ?? 0,
          },
        );
        continue;
      }
      // Fire-and-forget within the loop: the dispatch row is the durable
      // anchor. If the promise drops, the next poll reaps the lease and
      // tries again; if it completes, the runner calls completeDispatch.
      void runner
        .executeTask(task, { dispatchId: leased.id, launchOutbox: this })
        .catch((err) => {
          // The runner's outer catch should already have called failDispatch;
          // this is a defensive backstop for the case the runner itself threw
          // before reaching its own catch (e.g. synchronous setup error).
          this.failDispatch(leased.id, err);
        });
    }
    if (dispatched > 0) {
      this.logger?.info?.('[launch-dispatcher] dispatched', {
        ownerId: this.ownerId,
        dispatched,
        maxLeasesPerPoll: this.maxLeasesPerPoll,
        module: 'launch-dispatcher',
      });
    }
  }

  private resolveTaskForDispatch(dispatch: TaskLaunchDispatch): TaskState | undefined {
    try {
      this.orchestrator?.syncFromDb?.(dispatch.workflowId);
    } catch (err) {
      this.logger?.warn?.('[launch-dispatcher] workflow hydration failed before dispatch', {
        ownerId: this.ownerId,
        workflowId: dispatch.workflowId,
        taskId: dispatch.taskId,
        dispatchId: dispatch.id,
        error: err instanceof Error ? err.message : String(err),
        module: 'launch-dispatcher',
      });
    }

    return this.orchestrator?.getTask?.(dispatch.taskId);
  }

  private dispatchMatchesTask(dispatch: TaskLaunchDispatch, task: TaskState): boolean {
    return task.execution.selectedAttemptId === dispatch.attemptId
      && (task.execution.generation ?? 0) === (dispatch.generation ?? 0);
  }

  private abandonInvalidDispatch(
    dispatch: TaskLaunchDispatch,
    message: string,
    reason: string,
    details: Record<string, unknown> = {},
  ): void {
    const accepted = this.persistence.markLaunchDispatchAbandoned(dispatch.id, message);
    if (accepted) {
      this.releaseTaskResourceLeases(dispatch.taskId, dispatch.id, reason);
    }
    this.persistence.logEvent?.(dispatch.taskId, 'task.launch_dispatch_invalidated', {
      dispatchId: dispatch.id,
      dispatchAttemptId: dispatch.attemptId,
      dispatchGeneration: dispatch.generation,
      reason,
      message,
      accepted,
      ...details,
    });
    this.logger?.warn?.('[launch-dispatcher] abandoned invalid dispatch', {
      ownerId: this.ownerId,
      dispatchId: dispatch.id,
      taskId: dispatch.taskId,
      dispatchAttemptId: dispatch.attemptId,
      dispatchGeneration: dispatch.generation,
      reason,
      accepted,
      module: 'launch-dispatcher',
    });
  }

  /**
   * Reset every `leased` row whose `fenced_until` has passed back to
   * `enqueued` so the next `poll()` can re-lease it. Emits a
   * `task.launch_dispatch_reaped` audit event per reaped row.
   * Returns the number of rows reaped.
   */
  reapExpiredLeases(nowIso?: string): number {
    const reaped = this.persistence.reapExpiredLaunchDispatchLeases({
      nowIso,
      maxAttempts: this.maxAttempts,
    });
    for (const row of reaped) {
      this.persistence.logEvent?.(row.taskId, 'task.launch_dispatch_reaped', {
        dispatchId: row.id,
        attemptId: row.attemptId,
        attemptsCount: row.attemptsCount,
        reason: 'lease_expired',
      });
    }
    if (reaped.length > 0) {
      this.logger?.info?.('[launch-dispatcher] reaped', {
        ownerId: this.ownerId,
        count: reaped.length,
        dispatchIds: reaped.map((row) => row.id),
        module: 'launch-dispatcher',
      });
    }
    return reaped.length;
  }

  /**
   * For every `leased` row whose fence has expired AND whose
   * attempts_count has reached `maxAttempts`, transition it to
   * `abandoned`, ask the orchestrator to prepare a fresh attempt, and
   * emit a real `task.failed` event with a concrete error message.
   * Returns the number of rows abandoned.
   */
  abandonStuckLeases(nowIso?: string): number {
    const candidates = this.persistence.listAbandonableLaunchDispatchLeases({
      nowIso,
      maxAttempts: this.maxAttempts,
    });
    if (candidates.length === 0) return 0;
    let abandoned = 0;
    for (const row of candidates) {
      const message =
        `Launch dispatch abandoned after ${row.attemptsCount} attempt(s); ` +
        `last error: ${row.lastError ?? 'no concrete error recorded'}`;
      const ok = this.persistence.markLaunchDispatchAbandoned(row.id, message, nowIso);
      if (!ok) continue;
      abandoned += 1;
      this.persistence.logEvent?.(row.taskId, 'task.failed', {
        source: 'launch-dispatcher',
        dispatchId: row.id,
        attemptId: row.attemptId,
        attemptsCount: row.attemptsCount,
        error: message,
      });
      // CD.2 / Issue 14: release any execution-resource leases (SSH
      // pool slots, worktree pool entries, etc.) the task acquired
      // during executor selection but never released because the
      // launch never completed. Without this, a launch abandoned
      // during SSH selection leaves the pool slot reserved until its
      // own lease expiry, which can starve the next launch.
      this.releaseTaskResourceLeases(row.taskId, row.id);
      try {
        this.orchestrator?.prepareTaskForNewAttempt(row.taskId, 'launch-dispatch-abandoned');
      } catch (err) {
        this.logger?.warn?.('[launch-dispatcher] prepareTaskForNewAttempt failed', {
          ownerId: this.ownerId,
          taskId: row.taskId,
          dispatchId: row.id,
          error: err instanceof Error ? err.message : String(err),
          module: 'launch-dispatcher',
        });
      }
    }
    if (abandoned > 0) {
      this.logger?.warn?.('[launch-dispatcher] abandoned', {
        ownerId: this.ownerId,
        count: abandoned,
        dispatchIds: candidates.map((row) => row.id),
        module: 'launch-dispatcher',
      });
    }
    return abandoned;
  }

  /**
   * Release every execution-resource lease (SSH pool slot, worktree
   * pool member, ...) held on behalf of a task whose launch dispatch
   * was just abandoned. Best-effort: each release runs in its own
   * try/catch so a single stuck row cannot prevent the others from
   * being released, and any I/O failure is logged but does not
   * propagate (abandonStuckLeases must remain idempotent under
   * repeated polls).
   */
  private releaseTaskResourceLeases(
    taskId: string,
    dispatchId: number,
    reason = 'launch-dispatch-abandoned',
  ): void {
    let leases: ReadonlyArray<{ resourceKey: string; holderId: string; resourceType: string }> = [];
    try {
      leases = this.persistence.listExecutionResourceLeasesByTask(taskId);
    } catch (err) {
      this.logger?.warn?.(
        '[launch-dispatcher] listExecutionResourceLeasesByTask failed',
        {
          ownerId: this.ownerId,
          taskId,
          dispatchId,
          error: err instanceof Error ? err.message : String(err),
          module: 'launch-dispatcher',
        },
      );
      return;
    }
    if (leases.length === 0) return;
    let released = 0;
    for (const lease of leases) {
      try {
        this.persistence.releaseExecutionResourceLease(lease.resourceKey, lease.holderId);
        released += 1;
        this.persistence.logEvent?.(taskId, 'task.launch_dispatch_lease_released', {
          dispatchId,
          resourceKey: lease.resourceKey,
          resourceType: lease.resourceType,
          holderId: lease.holderId,
          reason,
        });
      } catch (err) {
        this.logger?.warn?.(
          '[launch-dispatcher] releaseExecutionResourceLease failed',
          {
            ownerId: this.ownerId,
            taskId,
            dispatchId,
            resourceKey: lease.resourceKey,
            holderId: lease.holderId,
            error: err instanceof Error ? err.message : String(err),
            module: 'launch-dispatcher',
          },
        );
      }
    }
    if (released > 0) {
      this.logger?.info?.('[launch-dispatcher] released resource leases', {
        ownerId: this.ownerId,
        taskId,
        dispatchId,
        released,
        total: leases.length,
        module: 'launch-dispatcher',
      });
    }
  }

  /**
   * Transition a live dispatch row to completed. Called by the
   * TaskRunner once {@link markTaskRunningAfterLaunch} has succeeded
   * (the executor handle is live and the task is in the executing
   * phase). Returns false when the row is already terminal.
   */
  completeDispatch(dispatchId: number): boolean {
    const ok = this.persistence.markLaunchDispatchCompleted(dispatchId);
    this.logger?.info?.('[launch-dispatcher] complete', {
      ownerId: this.ownerId,
      dispatchId,
      accepted: ok,
      module: 'launch-dispatcher',
    });
    return ok;
  }

  /**
   * Record a launch failure by re-enqueuing the dispatch row and storing
   * the error message in `last_error`. The dispatcher's reaper /
   * abandon-after-N-attempts logic decides whether to retry or abandon.
   * Returns false when the row is already terminal.
   */
  failDispatch(dispatchId: number, error: unknown): boolean {
    const message =
      error instanceof Error ? error.message : String(error ?? 'unknown launch error');
    const ok = this.persistence.markLaunchDispatchFailed(dispatchId, message);
    this.logger?.info?.('[launch-dispatcher] fail', {
      ownerId: this.ownerId,
      dispatchId,
      error: message,
      accepted: ok,
      module: 'launch-dispatcher',
    });
    return ok;
  }
}


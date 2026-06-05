/**
 * Phase A observer for the launch-handoff outbox.
 *
 * In observer mode the dispatcher does not own dispatch. It only reads
 * `task_launch_dispatch` rows and logs an aggregate count by state so we
 * have production data on outbox build-up before the active dispatcher
 * (CB.5) takes over.
 *
 * See:
 * - `docs/incidents/2026-05-22-launch-handoff-architecture-proposal.md`
 *   (the architecture target)
 * - `docs/incidents/2026-05-22-launch-handoff-orphan-architecture.md`
 *   (the investigation that motivated the rewrite)
 */

import type { SQLiteAdapter, TaskLaunchDispatch, TaskLaunchDispatchState } from '@invoker/data-store';
import type { LaunchOutboxAck } from '@invoker/execution-engine';
import type { TaskLaunchReadiness, TaskState } from '@invoker/workflow-core';
import { DISPATCH_MAX_ATTEMPTS, type Logger } from '@invoker/contracts';

export type LaunchDispatcherMode = 'observe' | 'active';

export type LaunchDispatcherPersistence = Pick<
  SQLiteAdapter,
  | 'listLaunchDispatchesByState'
  | 'markLaunchDispatchAcknowledged'
  | 'markLaunchDispatchCompleted'
  | 'markLaunchDispatchFailed'
  | 'markLaunchDispatchAbandoned'
  | 'reapExpiredLaunchDispatchLeases'
  | 'listAbandonableAcknowledgedLeases'
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
  mode: LaunchDispatcherMode;
  maxAttempts?: number;
  maxConcurrency?: number;
  maxLeasesPerPoll?: number;
}

const OBSERVED_STATES: readonly TaskLaunchDispatchState[] = [
  'enqueued',
  'leased',
  'acknowledged',
];

export class LaunchDispatcher {
  private readonly persistence: LaunchDispatcherPersistence;
  private readonly orchestrator?: LaunchDispatcherOrchestrator;
  private readonly taskRunnerProvider?: () => LaunchDispatcherTaskRunner | null;
  private readonly ownerId: string;
  private readonly logger?: Logger;
  private readonly mode: LaunchDispatcherMode;
  private readonly maxAttempts: number;
  private readonly maxConcurrency: number;
  private readonly maxLeasesPerPoll: number;

  constructor(options: LaunchDispatcherOptions) {
    this.persistence = options.persistence;
    this.orchestrator = options.orchestrator;
    this.taskRunnerProvider = options.taskRunnerProvider;
    this.ownerId = options.ownerId;
    this.logger = options.logger;
    this.mode = options.mode;
    this.maxAttempts = options.maxAttempts ?? DISPATCH_MAX_ATTEMPTS;
    this.maxConcurrency = options.maxConcurrency ?? 16;
    // Bound a single poll's work so the dispatcher cannot starve other
    // owner-loop ticks; the leftover rows are picked up on the next tick.
    this.maxLeasesPerPoll = options.maxLeasesPerPoll ?? 32;
  }

  getMode(): LaunchDispatcherMode {
    return this.mode;
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * Single dispatcher tick:
   *
   *   1. Reap any leased rows whose dispatch lease expired (TaskRunner
   *      never acked — we want to try again).
   *   2. Abandon any acknowledged rows whose dispatch lease expired AND
   *      that have exhausted their retry budget (TaskRunner accepted
   *      ownership but never completed; report the failure and let the
   *      orchestrator prepare a fresh attempt).
   *   3. In observe mode, log the aggregate state counts. In active mode,
   *      (CB.5) lease and dispatch new work.
   *
   * Steps 1 and 2 run in BOTH observer and active modes. They only mutate
   * already-stuck rows, so they are safe under observer mode — the goal
   * is to surface the orphan condition with concrete events rather than
   * letting it accumulate silently.
   */
  poll(): void {
    this.reapExpiredLeases();
    this.abandonStuckLeases();

    if (this.mode === 'observe') {
      const rows = this.persistence.listLaunchDispatchesByState(OBSERVED_STATES);
      const counts = countByState(rows);
      this.logger?.info?.('[launch-dispatcher] observed', {
        ownerId: this.ownerId,
        mode: this.mode,
        counts,
        total: rows.length,
        module: 'launch-dispatcher',
      });
      return;
    }
    this.dispatchActive();
  }

  /**
   * Active-mode dispatch loop. Lease as many enqueued rows as capacity
   * allows (bounded by `maxLeasesPerPoll`) and hand each one to the
   * TaskRunner. The TaskRunner ack/complete/fail flow drives the rest
   * of the lifecycle; if the JS promise drops mid-flight, the durable
   * outbox row stays leased and the next poll's `reapExpiredLeases`
   * reclaims it after `DISPATCH_LEASE_MS`.
   */
  private dispatchActive(): void {
    const runner = this.taskRunnerProvider?.() ?? null;
    if (!runner) {
      this.logger?.warn?.('[launch-dispatcher] active mode without taskRunner — skipping dispatch', {
        ownerId: this.ownerId,
        module: 'launch-dispatcher',
      });
      return;
    }
    let dispatched = 0;
    while (dispatched < this.maxLeasesPerPoll) {
      const leased = this.persistence.claimLaunchDispatchAtomic({
        ownerId: this.ownerId,
        maxConcurrency: this.maxConcurrency,
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
      const lineageMismatch = this.getDispatchLineageMismatch(leased, task);
      if (lineageMismatch) {
        this.abandonInvalidDispatch(
          leased,
          lineageMismatch.message,
          lineageMismatch.reason,
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

  private getDispatchLineageMismatch(
    dispatch: TaskLaunchDispatch,
    task: TaskState,
  ): { reason: string; message: string } | undefined {
    if (task.execution.selectedAttemptId !== dispatch.attemptId) {
      return {
        reason: 'selected_attempt_mismatch',
        message:
          `Launch dispatch ${dispatch.id} is stale: attempt ${dispatch.attemptId} ` +
          `is not the selected attempt ${task.execution.selectedAttemptId ?? 'none'}`,
      };
    }
    const selectedGeneration = task.execution.generation ?? 0;
    const dispatchGeneration = dispatch.generation ?? 0;
    if (selectedGeneration !== dispatchGeneration) {
      return {
        reason: 'generation_mismatch',
        message:
          `Launch dispatch ${dispatch.id} is stale: generation ${dispatchGeneration} ` +
          `does not match task generation ${selectedGeneration}`,
      };
    }
    return undefined;
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
    const reaped = this.persistence.reapExpiredLaunchDispatchLeases(nowIso);
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
   * For every `acknowledged` row whose fence has expired AND whose
   * attempts_count has reached `maxAttempts`, transition it to
   * `abandoned`, ask the orchestrator to prepare a fresh attempt, and
   * emit a real `task.failed` event with a concrete error message.
   * Returns the number of rows abandoned.
   */
  abandonStuckLeases(nowIso?: string): number {
    const candidates = this.persistence.listAbandonableAcknowledgedLeases({
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
   * Transition a leased dispatch row to acknowledged. Called by the
   * TaskRunner at the top of {@link executeTask} once it has accepted
   * ownership of the launch. Returns false when the row is no longer
   * in `leased` (e.g. it was reaped first), in which case the runner
   * should bail out without starting the executor.
   */
  ackDispatch(dispatchId: number, runnerId: string): boolean {
    const ok = this.persistence.markLaunchDispatchAcknowledged(dispatchId, runnerId);
    this.logger?.info?.('[launch-dispatcher] ack', {
      ownerId: this.ownerId,
      dispatchId,
      runnerId,
      accepted: ok,
      module: 'launch-dispatcher',
    });
    return ok;
  }

  /**
   * Transition an acknowledged dispatch row to completed. Called by the
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

function countByState(
  rows: readonly TaskLaunchDispatch[],
): Record<TaskLaunchDispatchState, number> {
  const counts: Record<TaskLaunchDispatchState, number> = {
    enqueued: 0,
    leased: 0,
    acknowledged: 0,
    completed: 0,
    abandoned: 0,
  };
  for (const row of rows) {
    counts[row.state] += 1;
  }
  return counts;
}

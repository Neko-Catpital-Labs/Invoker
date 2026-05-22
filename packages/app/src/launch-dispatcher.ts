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
  | 'logEvent'
>;

/**
 * Narrow interface for the orchestrator surface the dispatcher needs.
 * Avoids widening the dependency on the whole Orchestrator class.
 */
export interface LaunchDispatcherOrchestrator {
  prepareTaskForNewAttempt(taskId: string, reason: string): unknown;
}

export interface LaunchDispatcherOptions {
  persistence: LaunchDispatcherPersistence;
  orchestrator?: LaunchDispatcherOrchestrator;
  ownerId: string;
  logger?: Logger;
  mode: LaunchDispatcherMode;
  maxAttempts?: number;
}

const OBSERVED_STATES: readonly TaskLaunchDispatchState[] = [
  'enqueued',
  'leased',
  'acknowledged',
];

export class LaunchDispatcher {
  private readonly persistence: LaunchDispatcherPersistence;
  private readonly orchestrator?: LaunchDispatcherOrchestrator;
  private readonly ownerId: string;
  private readonly logger?: Logger;
  private readonly mode: LaunchDispatcherMode;
  private readonly maxAttempts: number;

  constructor(options: LaunchDispatcherOptions) {
    this.persistence = options.persistence;
    this.orchestrator = options.orchestrator;
    this.ownerId = options.ownerId;
    this.logger = options.logger;
    this.mode = options.mode;
    this.maxAttempts = options.maxAttempts ?? DISPATCH_MAX_ATTEMPTS;
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
    throw new Error('CB.5 not implemented');
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

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
import type { Logger } from '@invoker/contracts';

export type LaunchDispatcherMode = 'observe' | 'active';

export type LaunchDispatcherPersistence = Pick<
  SQLiteAdapter,
  | 'listLaunchDispatchesByState'
  | 'markLaunchDispatchAcknowledged'
  | 'markLaunchDispatchCompleted'
  | 'markLaunchDispatchFailed'
>;

export interface LaunchDispatcherOptions {
  persistence: LaunchDispatcherPersistence;
  ownerId: string;
  logger?: Logger;
  mode: LaunchDispatcherMode;
}

const OBSERVED_STATES: readonly TaskLaunchDispatchState[] = [
  'enqueued',
  'leased',
  'acknowledged',
];

export class LaunchDispatcher {
  private readonly persistence: LaunchDispatcherPersistence;
  private readonly ownerId: string;
  private readonly logger?: Logger;
  private readonly mode: LaunchDispatcherMode;

  constructor(options: LaunchDispatcherOptions) {
    this.persistence = options.persistence;
    this.ownerId = options.ownerId;
    this.logger = options.logger;
    this.mode = options.mode;
  }

  getMode(): LaunchDispatcherMode {
    return this.mode;
  }

  getOwnerId(): string {
    return this.ownerId;
  }

  /**
   * In observe mode, list non-terminal rows and log aggregate counts.
   * In active mode, dispatch real work — Phase B (CB.5) provides the
   * implementation; today this throws so the placeholder is visible.
   */
  poll(): void {
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

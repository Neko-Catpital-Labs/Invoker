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

export interface LaunchDispatcherOptions {
  persistence: Pick<SQLiteAdapter, 'listLaunchDispatchesByState'>;
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
  private readonly persistence: LaunchDispatcherOptions['persistence'];
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

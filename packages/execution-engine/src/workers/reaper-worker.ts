import type { Logger } from '@invoker/contracts';
import { tmpdir } from 'node:os';

import { resolveInvokerHomeRoot } from '../worker-lock.js';
import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

import type { RemoteDiskTarget } from './disk-headroom-monitor.js';
import {
  enforceHourlySnapshotRetention,
  reapDeletingOrphans,
  reapStaleInvokerCliTempDirs,
  reapStaleAutomationCheckouts,
  reapStaleWorktrees,
  trimOversizedLogs,
} from './reaper-reclaim.js';

export const REAPER_WORKER_KIND = 'reaper';

export const DEFAULT_REAPER_INTERVAL_MS = 60 * 60 * 1000;

export function resolveReaperIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.INVOKER_REAPER_INTERVAL_MS;
  if (!raw) return DEFAULT_REAPER_INTERVAL_MS;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_REAPER_INTERVAL_MS;
  return n;
}

export interface ReaperWorkerOptions {
  logger: Logger;
  invokerHome: string;
  remoteTargets?: RemoteDiskTarget[];
  intervalMs?: number;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  /** Test seam: override the orphaned dot-deleting reap. */
  reapOrphans?: typeof reapDeletingOrphans;
  /** Test seam: override the stale automation-checkout reap. */
  reapCheckouts?: typeof reapStaleAutomationCheckouts;
  /** Test seam: override stale task-worktree reap. */
  reapWorktrees?: typeof reapStaleWorktrees;
  /** Test seam: override stale CLI temp-directory reap. */
  reapTempDirs?: typeof reapStaleInvokerCliTempDirs;
  /** Test seam: override snapshot-retention enforcement. */
  enforceRetention?: typeof enforceHourlySnapshotRetention;
  /** Test seam: override oversized-log trimming. */
  trimLogs?: typeof trimOversizedLogs;
  /** Test seam: wrap the worker tick for observability. */
  onTick?: WorkerTick;
}

export function createReaperWorker(options: ReaperWorkerOptions): WorkerRuntime {
  const reapOrphans = options.reapOrphans ?? reapDeletingOrphans;
  const reapCheckouts = options.reapCheckouts ?? reapStaleAutomationCheckouts;
  const reapWorktrees = options.reapWorktrees ?? reapStaleWorktrees;
  const reapTempDirs = options.reapTempDirs ?? reapStaleInvokerCliTempDirs;
  const enforceRetention = options.enforceRetention ?? enforceHourlySnapshotRetention;
  const trimLogs = options.trimLogs ?? trimOversizedLogs;

  return createWorkerRuntime({
    kind: REAPER_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? resolveReaperIntervalMs(),
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const orphanResults = await reapOrphans({
        invokerHome: options.invokerHome,
        remoteTargets: options.remoteTargets ?? [],
        logger: options.logger,
      });
      if (ctx.signal?.aborted) return;

      const checkoutsRemoved = reapCheckouts({
        invokerHome: options.invokerHome,
        logger: options.logger,
      });
      const tempDirsRemoved = await reapTempDirs({
        tempRoot: tmpdir(),
        logger: options.logger,
      });
      if (ctx.signal?.aborted) return;
      const snapshotsPruned = enforceRetention(options.invokerHome);
      const logsTrimmed = trimLogs({
        invokerHome: options.invokerHome,
        logger: options.logger,
      });
      const worktreeResults = await reapWorktrees({
        invokerHome: options.invokerHome,
        remoteTargets: options.remoteTargets ?? [],
        logger: options.logger,
      });
      const worktreesRemoved = worktreeResults.reduce((sum, result) => {
        const match = result.detail?.match(/^removed (\d+)$/);
        return sum + (match ? Number.parseInt(match[1] ?? '0', 10) : 0);
      }, 0);

      const orphanFailed = orphanResults.filter((result) => !result.ok);
      const failed = [...orphanResults, ...worktreeResults].filter((result) => !result.ok);
      const summary =
        `Reaper pass: orphan targets ${orphanResults.length - orphanFailed.length}/${orphanResults.length} ok, `
        + `checkouts removed ${checkoutsRemoved.length}, CLI temp dirs removed ${tempDirsRemoved.length}, `
        + `snapshots pruned ${snapshotsPruned}, `
        + `logs trimmed ${logsTrimmed.length}, worktrees removed ${worktreesRemoved}`;

      if (options.store) {
        recordWorkerDecisionRow(options.store, {
          workerKind: REAPER_WORKER_KIND,
          actionType: 'reaper-pass',
          externalKey: 'pass',
          subjectType: 'invoker-home',
          subjectId: options.invokerHome,
          status: failed.length > 0 ? 'failed' : 'completed',
          summary,
          ...(failed.length > 0 ? { reason: failed[0]?.reason } : {}),
          payload: {
            orphanResults,
            checkoutsRemoved,
            tempDirsRemoved,
            snapshotsPruned,
            logsTrimmed,
            worktreeResults,
            worktreesRemoved,
          },
          incrementAttempt: true,
        });
      }
      options.logger.info?.(`[reaper] ${summary}`, { module: 'reaper' });
    },
  });
}

/** Register the built-in reaper worker (interval-driven disk hygiene). */
export function registerReaperWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: REAPER_WORKER_KIND,
    note: 'Reaps orphaned .deleting dirs, stale automation checkouts, stale CLI temp dirs, stale task worktrees, excess hourly snapshots, and oversized logs on an interval.',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createReaperWorker({
        logger: deps.logger,
        invokerHome: deps.diskHeadroom?.localPath ?? resolveInvokerHomeRoot(),
        remoteTargets: deps.diskHeadroom?.remoteTargets ?? [],
        store: deps.store,
      }),
  });
  return registry;
}

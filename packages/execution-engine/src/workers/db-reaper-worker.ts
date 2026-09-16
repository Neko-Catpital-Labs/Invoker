import { setImmediate as yieldToRequests } from 'node:timers/promises';
import type { Logger } from '@invoker/contracts';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const DB_REAPER_WORKER_KIND = 'db-reaper';
export const DEFAULT_DB_REAPER_INTERVAL_MINUTES = 60;
export const DEFAULT_DB_REAPER_INTERVAL_MS = DEFAULT_DB_REAPER_INTERVAL_MINUTES * 60_000;
export const DEFAULT_EVENTS_RETENTION_DAYS = 14;
export const DEFAULT_SYNC_JOURNAL_RETENTION_DAYS = 14;
export const DEFAULT_VACUUM_FREELIST_THRESHOLD_PAGES = 10_000;
export const DEFAULT_VACUUM_MAX_PAGES_PER_TICK = 2_000;

export interface DbReaperWorkerStore {
  pruneOldEvents(retentionDays: number): number;
  pruneOldSyncJournal(retentionDays: number): number;
  getFreelistPageCount(): number;
  runIncrementalVacuum(maxPages: number): number;
}

export interface DbReaperWorkerConfig {
  intervalMs?: number;
  eventsRetentionDays?: number;
  syncJournalRetentionDays?: number;
  vacuumFreelistThresholdPages?: number;
  vacuumMaxPagesPerTick?: number;
  tickOnStart?: boolean;
  store?: WorkerDecisionStore;
  onTick?: WorkerTick;
}

export interface DbReaperWorkerOptions {
  logger: Logger;
  store: DbReaperWorkerStore;
  intervalMs?: number;
  eventsRetentionDays: number;
  syncJournalRetentionDays: number;
  vacuumFreelistThresholdPages?: number;
  vacuumMaxPagesPerTick?: number;
  tickOnStart?: boolean;
  decisionStore?: WorkerDecisionStore;
  onTick?: WorkerTick;
}

export function createDbReaperWorker(options: DbReaperWorkerOptions): WorkerRuntime {
  return createWorkerRuntime({
    kind: DB_REAPER_WORKER_KIND,
    logger: options.logger,
    intervalMs: options.intervalMs ?? DEFAULT_DB_REAPER_INTERVAL_MS,
    tickOnStart: options.tickOnStart ?? true,
    onTick: async (ctx) => {
      ctx.signal?.throwIfAborted();
      await options.onTick?.(ctx);
      ctx.signal?.throwIfAborted();

      const passStarted = performance.now();
      let batch = 0;
      const runBatch = async (operation: string, work: () => number): Promise<number> => {
        await yieldToRequests(undefined, { signal: ctx.signal });
        ctx.signal.throwIfAborted();
        const started = performance.now();
        const fields = { module: DB_REAPER_WORKER_KIND, operation, batch: ++batch,
          tick: ctx.tickNumber, wall_time: new Date().toISOString(), monotonic_ms: started };
        options.logger.info('DB maintenance batch started', { ...fields, event: 'start' });
        try {
          const affected = work();
          options.logger.info('DB maintenance batch finished', { ...fields, event: 'end',
            wall_time: new Date().toISOString(), monotonic_ms: performance.now(),
            duration_ms: performance.now() - started, affected });
          return affected;
        } catch (error) {
          options.logger.error('DB maintenance batch failed', { ...fields, event: 'error',
            wall_time: new Date().toISOString(), monotonic_ms: performance.now(),
            duration_ms: performance.now() - started, error });
          throw error;
        }
      };
      const prune = async (operation: string, work: () => number): Promise<number> => {
        let total = 0;
        for (let i = 0; i < 20; i += 1) {
          const deleted = await runBatch(operation, work);
          total += deleted;
          if (deleted < 1000 || performance.now() - passStarted >= 50) break;
        }
        return total;
      };
      const eventsPruned = await prune('events.retention',
        () => options.store.pruneOldEvents(options.eventsRetentionDays));
      const syncJournalPruned = await prune('sync_journal.retention',
        () => options.store.pruneOldSyncJournal(options.syncJournalRetentionDays));

      const vacuumThreshold = options.vacuumFreelistThresholdPages ?? DEFAULT_VACUUM_FREELIST_THRESHOLD_PAGES;
      const vacuumMaxPages = options.vacuumMaxPagesPerTick ?? DEFAULT_VACUUM_MAX_PAGES_PER_TICK;
      const freelistPages = await runBatch('freelist_count', () => options.store.getFreelistPageCount());
      let pagesVacuumed = 0;
      if (freelistPages > vacuumThreshold) {
        let remaining = Math.min(vacuumMaxPages, DEFAULT_VACUUM_MAX_PAGES_PER_TICK);
        while (remaining > 0 && performance.now() - passStarted < 50) {
          const pages = Math.min(100, remaining);
          const reclaimed = await runBatch('incremental_vacuum', () => options.store.runIncrementalVacuum(pages));
          pagesVacuumed += reclaimed;
          remaining -= pages;
          if (reclaimed === 0) break;
        }
      }

      const summary = `DB reaper pass: ${eventsPruned} old event row(s) pruned `
        + `(retention=${options.eventsRetentionDays}d), ${syncJournalPruned} old sync_journal row(s) pruned `
        + `(retention=${options.syncJournalRetentionDays}d), ${pagesVacuumed} freelist page(s) reclaimed `
        + `(freelist was ${freelistPages}, threshold=${vacuumThreshold})`;

      if (options.decisionStore) {
        recordWorkerDecisionRow(options.decisionStore, {
          workerKind: DB_REAPER_WORKER_KIND,
          actionType: 'db-reaper-pass',
          externalKey: 'pass',
          subjectType: 'invoker-db',
          subjectId: 'invoker.db',
          status: 'completed',
          summary,
          payload: { eventsPruned, syncJournalPruned, pagesVacuumed, freelistPages },
          incrementAttempt: true,
        });
      }
      options.logger.info?.(`[${DB_REAPER_WORKER_KIND}] ${summary}`, { module: DB_REAPER_WORKER_KIND });
    },
  });
}

export function registerDbReaperWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: DB_REAPER_WORKER_KIND,
    note: 'Prunes events older than retention for terminal-status tasks, sync_journal rows every known peer has already received, and reclaims freelist space via incremental vacuum once auto_vacuum is enabled.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createDbReaperWorker({
        logger: deps.logger,
        store: deps.store,
        decisionStore: deps.store,
        intervalMs: deps.dbReaper?.intervalMs,
        eventsRetentionDays: deps.dbReaper?.eventsRetentionDays ?? DEFAULT_EVENTS_RETENTION_DAYS,
        syncJournalRetentionDays: deps.dbReaper?.syncJournalRetentionDays ?? DEFAULT_SYNC_JOURNAL_RETENTION_DAYS,
        vacuumFreelistThresholdPages: deps.dbReaper?.vacuumFreelistThresholdPages,
        vacuumMaxPagesPerTick: deps.dbReaper?.vacuumMaxPagesPerTick,
        tickOnStart: deps.dbReaper?.tickOnStart,
      }),
  });
  return registry;
}

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

export interface DbReaperWorkerStore {
  pruneOldEvents(retentionDays: number): number;
  pruneOldSyncJournal(retentionDays: number): number;
}

export interface DbReaperWorkerConfig {
  intervalMs?: number;
  eventsRetentionDays?: number;
  syncJournalRetentionDays?: number;
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

      const eventsPruned = options.store.pruneOldEvents(options.eventsRetentionDays);
      ctx.signal?.throwIfAborted();
      const syncJournalPruned = options.store.pruneOldSyncJournal(options.syncJournalRetentionDays);

      const summary = `DB reaper pass: ${eventsPruned} old event row(s) pruned `
        + `(retention=${options.eventsRetentionDays}d), ${syncJournalPruned} old sync_journal row(s) pruned `
        + `(retention=${options.syncJournalRetentionDays}d)`;

      if (options.decisionStore) {
        recordWorkerDecisionRow(options.decisionStore, {
          workerKind: DB_REAPER_WORKER_KIND,
          actionType: 'db-reaper-pass',
          externalKey: 'pass',
          subjectType: 'invoker-db',
          subjectId: 'invoker.db',
          status: 'completed',
          summary,
          payload: { eventsPruned, syncJournalPruned },
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
    note: 'Prunes events older than retention for terminal-status tasks, and sync_journal rows every known peer has already received.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime =>
      createDbReaperWorker({
        logger: deps.logger,
        store: deps.store,
        decisionStore: deps.store,
        intervalMs: deps.dbReaper?.intervalMs,
        eventsRetentionDays: deps.dbReaper?.eventsRetentionDays ?? DEFAULT_EVENTS_RETENTION_DAYS,
        syncJournalRetentionDays: deps.dbReaper?.syncJournalRetentionDays ?? DEFAULT_SYNC_JOURNAL_RETENTION_DAYS,
        tickOnStart: deps.dbReaper?.tickOnStart,
      }),
  });
  return registry;
}

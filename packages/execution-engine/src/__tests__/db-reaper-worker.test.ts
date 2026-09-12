import { describe, expect, it, vi } from 'vitest';

import {
  DB_REAPER_WORKER_KIND,
  DEFAULT_EVENTS_RETENTION_DAYS,
  DEFAULT_SYNC_JOURNAL_RETENTION_DAYS,
  createDbReaperWorker,
  registerDbReaperWorker,
  type DbReaperWorkerStore,
} from '../workers/db-reaper-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

class FakeDbReaperStore implements DbReaperWorkerStore {
  readonly pruneOldEventsCalls: number[] = [];
  readonly pruneOldSyncJournalCalls: number[] = [];
  readonly runIncrementalVacuumCalls: number[] = [];

  constructor(
    private readonly eventsPruned = 0,
    private readonly syncJournalPruned = 0,
    private readonly freelistPages = 0,
    private readonly pagesVacuumed = 0,
  ) {}

  pruneOldEvents(retentionDays: number): number {
    this.pruneOldEventsCalls.push(retentionDays);
    return this.eventsPruned;
  }

  pruneOldSyncJournal(retentionDays: number): number {
    this.pruneOldSyncJournalCalls.push(retentionDays);
    return this.syncJournalPruned;
  }

  getFreelistPageCount(): number {
    return this.freelistPages;
  }

  runIncrementalVacuum(maxPages: number): number {
    this.runIncrementalVacuumCalls.push(maxPages);
    return this.pagesVacuumed;
  }
}

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('createDbReaperWorker', () => {
  it('prunes events and sync_journal using the configured retention windows on tick', async () => {
    const store = new FakeDbReaperStore(12, 34);
    const logger = makeLogger();
    const worker = createDbReaperWorker({
      logger,
      store,
      eventsRetentionDays: 7,
      syncJournalRetentionDays: 21,
      tickOnStart: false,
    });

    await worker.tick();

    expect(store.pruneOldEventsCalls).toEqual([7]);
    expect(store.pruneOldSyncJournalCalls).toEqual([21]);
  });

  it('does not run incremental vacuum when the freelist is below the configured threshold', async () => {
    const store = new FakeDbReaperStore(0, 0, 500, 0);
    const worker = createDbReaperWorker({
      logger: makeLogger(),
      store,
      eventsRetentionDays: 7,
      syncJournalRetentionDays: 21,
      vacuumFreelistThresholdPages: 1_000,
      tickOnStart: false,
    });

    await worker.tick();

    expect(store.runIncrementalVacuumCalls).toEqual([]);
  });

  it('runs incremental vacuum with the configured page cap once the freelist exceeds the threshold', async () => {
    const store = new FakeDbReaperStore(0, 0, 15_000, 800);
    const logger = makeLogger();
    const worker = createDbReaperWorker({
      logger,
      store,
      eventsRetentionDays: 7,
      syncJournalRetentionDays: 21,
      vacuumFreelistThresholdPages: 10_000,
      vacuumMaxPagesPerTick: 2_500,
      tickOnStart: false,
    });

    await worker.tick();

    expect(store.runIncrementalVacuumCalls).toEqual([2_500]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('800 freelist page(s) reclaimed'),
      expect.anything(),
    );
  });

  it('uses the documented default retention windows when none are configured', async () => {
    const store = new FakeDbReaperStore();
    const worker = createDbReaperWorker({
      logger: makeLogger(),
      store,
      eventsRetentionDays: DEFAULT_EVENTS_RETENTION_DAYS,
      syncJournalRetentionDays: DEFAULT_SYNC_JOURNAL_RETENTION_DAYS,
      tickOnStart: false,
    });

    await worker.tick();

    expect(store.pruneOldEventsCalls).toEqual([DEFAULT_EVENTS_RETENTION_DAYS]);
    expect(store.pruneOldSyncJournalCalls).toEqual([DEFAULT_SYNC_JOURNAL_RETENTION_DAYS]);
  });

  it('records a worker decision summarizing what was pruned', async () => {
    const store = new FakeDbReaperStore(5, 9);
    const upsertWorkerAction = vi.fn();
    const worker = createDbReaperWorker({
      logger: makeLogger(),
      store,
      eventsRetentionDays: 14,
      syncJournalRetentionDays: 14,
      tickOnStart: false,
      decisionStore: { upsertWorkerAction },
    });

    await worker.tick();

    expect(upsertWorkerAction).toHaveBeenCalledTimes(1);
    const [action] = upsertWorkerAction.mock.calls[0]!;
    expect(action.workerKind).toBe(DB_REAPER_WORKER_KIND);
    expect(action.status).toBe('completed');
    expect(action.summary).toContain('5 old event row(s) pruned');
    expect(action.summary).toContain('9 old sync_journal row(s) pruned');
  });
});

describe('registerDbReaperWorker', () => {
  it('registers under the db-reaper kind and wires the store through to the worker', async () => {
    const registry = createWorkerRegistry<WorkerRuntimeDependencies>();
    registerDbReaperWorker(registry);

    const store = new FakeDbReaperStore(1, 2);
    const deps: WorkerRuntimeDependencies = {
      store: store as unknown as WorkerRuntimeDependencies['store'],
      submitter: {} as WorkerRuntimeDependencies['submitter'],
      logger: makeLogger() as unknown as WorkerRuntimeDependencies['logger'],
      dbReaper: { eventsRetentionDays: 3, syncJournalRetentionDays: 4, tickOnStart: false },
    };

    const entry = registry.get(DB_REAPER_WORKER_KIND);
    expect(entry).toBeDefined();
    const worker = entry!.factory(deps);
    await worker.tick();

    expect(store.pruneOldEventsCalls).toEqual([3]);
    expect(store.pruneOldSyncJournalCalls).toEqual([4]);
  });
});

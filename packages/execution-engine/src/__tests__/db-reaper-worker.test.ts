import { describe, expect, it, vi } from 'vitest';

import type { MaintenanceBatchResult } from '@invoker/data-store';

import {
  DB_REAPER_PASS_BUDGET_MS,
  DB_REAPER_WORKER_KIND,
  DEFAULT_EVENTS_RETENTION_DAYS,
  DEFAULT_SYNC_JOURNAL_RETENTION_DAYS,
  createDbReaperWorker,
  registerDbReaperWorker,
  type DbReaperWorkerStore,
} from '../workers/db-reaper-worker.js';
import { createWorkerRegistry } from '../worker-registry.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';

const FAKE_BATCH_SCAN = 1000;

class FakeDbReaperStore implements DbReaperWorkerStore {
  readonly pruneOldEventsCalls: number[] = [];
  readonly pruneOldSyncJournalCalls: number[] = [];
  readonly runIncrementalVacuumCalls: number[] = [];

  constructor(
    private readonly eventsPruned = 0,
    private readonly syncJournalPruned = 0,
    private readonly freelistPages = 0,
    private readonly pagesVacuumed = 0,
    private readonly backlogBatches = 1,
  ) {}

  pruneOldEvents(retentionDays: number): MaintenanceBatchResult {
    this.pruneOldEventsCalls.push(retentionDays);
    return this.batch(this.eventsPruned, this.pruneOldEventsCalls.length);
  }

  pruneOldSyncJournal(retentionDays: number): MaintenanceBatchResult {
    this.pruneOldSyncJournalCalls.push(retentionDays);
    return this.batch(this.syncJournalPruned, this.pruneOldSyncJournalCalls.length);
  }

  private batch(deleted: number, callCount: number): MaintenanceBatchResult {
    const passDrained = callCount >= this.backlogBatches;
    return { deleted, scanned: passDrained ? deleted : FAKE_BATCH_SCAN, passDrained };
  }

  getFreelistPageCount(): number {
    return this.freelistPages;
  }

  runIncrementalVacuum(maxPages: number): number {
    this.runIncrementalVacuumCalls.push(maxPages);
    return this.pagesVacuumed;
  }
}

class BudgetDrainingPruneStore implements DbReaperWorkerStore {
  readonly runIncrementalVacuumCalls: number[] = [];
  spins = 0;

  constructor(
    private readonly freelistPages: number,
    private readonly prunePassMs: number,
  ) {}

  pruneOldEvents(): MaintenanceBatchResult {
    const until = performance.now() + this.prunePassMs;
    while (performance.now() < until) this.spins += 1;
    return { deleted: 0, scanned: 0, passDrained: true };
  }

  pruneOldSyncJournal(): MaintenanceBatchResult {
    return { deleted: 0, scanned: 0, passDrained: true };
  }

  getFreelistPageCount(): number {
    return this.freelistPages;
  }

  runIncrementalVacuum(maxPages: number): number {
    this.runIncrementalVacuumCalls.push(maxPages);
    return 0;
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
    const store = new FakeDbReaperStore(0, 0, 15_000, 100);
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

    expect(store.runIncrementalVacuumCalls).toEqual(Array(20).fill(100));
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('2000 freelist page(s) reclaimed'),
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

  it('yields to queued mutations between batches and caps a full backlog per tick', async () => {
    const store = new FakeDbReaperStore(1000, 1000, 0, 0, Number.POSITIVE_INFINITY);
    const logger = makeLogger();
    let requestRan = false;
    const original = store.pruneOldEvents.bind(store);
    store.pruneOldEvents = (days) => {
      if (store.pruneOldEventsCalls.length === 0) setImmediate(() => { requestRan = true; });
      else expect(requestRan).toBe(true);
      return original(days);
    };
    const worker = createDbReaperWorker({ logger, store,
      eventsRetentionDays: 14, syncJournalRetentionDays: 14, tickOnStart: false });
    await worker.tick();
    expect(requestRan).toBe(true);
    expect(store.pruneOldEventsCalls.length).toBeGreaterThan(1);
    expect(store.pruneOldEventsCalls.length).toBeLessThanOrEqual(20);
    expect(store.pruneOldSyncJournalCalls.length).toBeLessThanOrEqual(20);
    expect(logger.info).toHaveBeenCalledWith('DB maintenance batch finished',
      expect.objectContaining({ operation: 'events.retention', duration_ms: expect.any(Number), affected: 1000 }));
  });

  it('stops before the next batch when cancelled during a yield', async () => {
    const store = new FakeDbReaperStore(1000);
    const worker = createDbReaperWorker({ logger: makeLogger(), store,
      eventsRetentionDays: 14, syncJournalRetentionDays: 14, tickOnStart: false });
    store.pruneOldEvents = () => {
      store.pruneOldEventsCalls.push(14);
      setImmediate(() => { void worker.stop(); });
      return { deleted: 1000, scanned: FAKE_BATCH_SCAN, passDrained: false };
    };
    await worker.tick();
    expect(store.pruneOldEventsCalls).toHaveLength(1);
    expect(store.pruneOldSyncJournalCalls).toHaveLength(0);
  });

  it('reports incremental vacuum as pending when the pass budget drains before vacuum starts', async () => {
    const store = new BudgetDrainingPruneStore(15_000, DB_REAPER_PASS_BUDGET_MS + 10);
    const upsertWorkerAction = vi.fn();
    const logger = makeLogger();
    const worker = createDbReaperWorker({
      logger,
      store,
      eventsRetentionDays: 14,
      syncJournalRetentionDays: 14,
      vacuumFreelistThresholdPages: 10_000,
      tickOnStart: false,
      decisionStore: { upsertWorkerAction },
    });

    await worker.tick();

    expect(store.runIncrementalVacuumCalls).toEqual([]);
    const [action] = upsertWorkerAction.mock.calls[0]!;
    expect(action.status).toBe('pending');
    expect(action.payload).toMatchObject({
      pending: true, pendingOperations: ['incremental_vacuum'], pagesVacuumed: 0,
    });
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('pending: incremental_vacuum'),
      expect.anything(),
    );
  });

  it('does not report incremental vacuum as pending once the store reclaims nothing further', async () => {
    const store = new FakeDbReaperStore(0, 0, 15_000, 0);
    const upsertWorkerAction = vi.fn();
    const worker = createDbReaperWorker({
      logger: makeLogger(),
      store,
      eventsRetentionDays: 14,
      syncJournalRetentionDays: 14,
      vacuumFreelistThresholdPages: 10_000,
      tickOnStart: false,
      decisionStore: { upsertWorkerAction },
    });

    await worker.tick();

    expect(store.runIncrementalVacuumCalls).toEqual([100]);
    const [action] = upsertWorkerAction.mock.calls[0]!;
    expect(action.status).toBe('completed');
    expect(action.payload).toMatchObject({ pending: false, pendingOperations: [] });
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

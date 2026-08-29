import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WATCHED_WORKER_KINDS,
  REPAIR_FILING_STALE_TTL_MS,
  runAdminBypassE2eBabysitTick,
  type AdminBypassE2eBabysitWorkerOptions,
  type InvestigativePlanSubmitter,
  type RepairFilingRow,
  type RepairFilingStore,
  type WorkerLifecycleReader,
  type WorkerLifecycleSnapshot,
  type WorkerLifecycleStarter,
} from '../workers/admin-bypass-e2e-babysit-worker.js';
import type { WorkerDecisionStore } from '../worker-decision-ledger.js';

class FakeWorkerLifecycle implements WorkerLifecycleReader, WorkerLifecycleStarter {
  readonly startCalls: string[] = [];

  constructor(private readonly workers: readonly WorkerLifecycleSnapshot[]) {}

  listWorkers(): readonly WorkerLifecycleSnapshot[] {
    return this.workers;
  }

  start(kind: string): void {
    this.startCalls.push(kind);
  }
}

class FakeRepairFilingStore implements RepairFilingStore {
  readonly deleteCalls: Array<[kind: string, subject: string, stateSha: string]> = [];

  constructor(
    private readonly rows: readonly RepairFilingRow[],
    private readonly deleteError?: Error,
  ) {}

  listRepairFilings(): readonly RepairFilingRow[] {
    return this.rows;
  }

  deleteRepairFiling(kind: string, subject: string, stateSha: string): void {
    this.deleteCalls.push([kind, subject, stateSha]);
    if (this.deleteError) throw this.deleteError;
  }
}

class FakeInvestigativePlanSubmitter implements InvestigativePlanSubmitter {
  readonly submittedPlans: string[] = [];

  submitPlan(planText: string): void {
    this.submittedPlans.push(planText);
  }
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as AdminBypassE2eBabysitWorkerOptions['logger'];
}

function makeDecisionStore(): {
  store: WorkerDecisionStore;
  rows: Array<{ subjectId: string; status: string }>;
} {
  const rows: Array<{ subjectId: string; status: string }> = [];
  return {
    rows,
    store: {
      getWorkerAction: () => undefined,
      upsertWorkerAction: (action) => {
        rows.push({ subjectId: action.subjectId, status: action.status });
        return action as never;
      },
    },
  };
}

describe('runAdminBypassE2eBabysitTick', () => {
  it('starts only a watched worker that is desired-enabled and stopped, then files one investigation', async () => {
    const workerLifecycle = new FakeWorkerLifecycle([
      { kind: DEFAULT_WATCHED_WORKER_KINDS[0], desiredEnabled: true, lifecycle: 'stopped' },
      { kind: DEFAULT_WATCHED_WORKER_KINDS[1], desiredEnabled: true, lifecycle: 'running' },
      { kind: 'unwatched-worker', desiredEnabled: true, lifecycle: 'stopped' },
    ]);
    const repairFilings = new FakeRepairFilingStore([]);
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store } = makeDecisionStore();

    await runAdminBypassE2eBabysitTick({
      logger: makeLogger(),
      workerLifecycle,
      repairFilings,
      planSubmitter,
      store,
    });

    expect(workerLifecycle.startCalls).toEqual([DEFAULT_WATCHED_WORKER_KINDS[0]]);
    expect(planSubmitter.submittedPlans).toHaveLength(1);
    expect(planSubmitter.submittedPlans[0]).toContain('scratch: true');
    expect(planSubmitter.submittedPlans[0]).toContain(DEFAULT_WATCHED_WORKER_KINDS[0]);
  });

  it('deletes only a repair filing older than the stale TTL, then files one investigation', async () => {
    const now = Date.now();
    const oldRow: RepairFilingRow = {
      kind: 'admin-requeue:rebase-conflict',
      subject: '11219',
      stateSha: 'sha-old',
      createdAt: new Date(now - REPAIR_FILING_STALE_TTL_MS - 60_000).toISOString(),
    };
    const youngRow: RepairFilingRow = {
      kind: 'ci-regression:required-fast-guardrails',
      subject: 'master',
      stateSha: 'sha-young',
      createdAt: new Date(now).toISOString(),
    };
    const repairFilings = new FakeRepairFilingStore([oldRow, youngRow]);
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store } = makeDecisionStore();

    await runAdminBypassE2eBabysitTick({
      logger: makeLogger(),
      workerLifecycle: new FakeWorkerLifecycle([]),
      repairFilings,
      planSubmitter,
      store,
    });

    expect(repairFilings.deleteCalls).toEqual([[oldRow.kind, oldRow.subject, oldRow.stateSha]]);
    expect(planSubmitter.submittedPlans).toHaveLength(1);
    expect(planSubmitter.submittedPlans[0]).toContain('scratch: true');
    expect(planSubmitter.submittedPlans[0]).toContain(oldRow.kind);
    expect(planSubmitter.submittedPlans[0]).toContain(oldRow.subject);
  });

  it('does not submit a plan when there is nothing to act on', async () => {
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store } = makeDecisionStore();

    await runAdminBypassE2eBabysitTick({
      logger: makeLogger(),
      workerLifecycle: new FakeWorkerLifecycle([
        { kind: DEFAULT_WATCHED_WORKER_KINDS[0], desiredEnabled: false, lifecycle: 'stopped' },
      ]),
      repairFilings: new FakeRepairFilingStore([{
        kind: 'ci-regression:fleet',
        subject: 'master',
        stateSha: 'sha-fresh',
        createdAt: new Date().toISOString(),
      }]),
      planSubmitter,
      store,
    });

    expect(planSubmitter.submittedPlans).toHaveLength(0);
  });

  it('logs and records a failed deletion without throwing out of the tick', async () => {
    const staleRow: RepairFilingRow = {
      kind: 'admin-requeue:rebase-conflict',
      subject: '11219',
      stateSha: 'sha-stale',
      createdAt: new Date(Date.now() - REPAIR_FILING_STALE_TTL_MS - 60_000).toISOString(),
    };
    const logger = makeLogger();
    const repairFilings = new FakeRepairFilingStore([staleRow], new Error('delete failed'));
    const { store, rows } = makeDecisionStore();

    await expect(runAdminBypassE2eBabysitTick({
      logger,
      workerLifecycle: new FakeWorkerLifecycle([]),
      repairFilings,
      planSubmitter: new FakeInvestigativePlanSubmitter(),
      store,
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(rows).toContainEqual({ subjectId: 'admin-requeue:rebase-conflict:11219:sha-stale', status: 'failed' });
  });
});

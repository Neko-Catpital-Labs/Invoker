import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_WATCHED_WORKER_KINDS,
  E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX,
  E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX,
  REPAIR_FILING_STALE_TTL_MS,
  runAdminBypassE2eBabysitTick,
  type AdminBypassE2eBabysitWorkerOptions,
  type InvestigativePlanSubmitter,
  type RepairFilingInsertResult,
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
  readonly insertCalls: Array<{ kind: string; subject: string; stateSha: string }> = [];
  private readonly claimedKeys = new Set<string>();
  private rows: RepairFilingRow[];

  constructor(
    rows: readonly RepairFilingRow[],
    private readonly deleteError?: Error,
    private readonly insertError?: Error,
  ) {
    this.rows = [...rows];
    for (const row of rows) this.claimedKeys.add(`${row.kind}:${row.subject}:${row.stateSha}`);
  }

  listRepairFilings(): readonly RepairFilingRow[] {
    return this.rows;
  }

  deleteRepairFiling(kind: string, subject: string, stateSha: string): void {
    this.deleteCalls.push([kind, subject, stateSha]);
    if (this.deleteError) throw this.deleteError;
  }

  insertRepairFiling(input: { kind: string; subject: string; stateSha: string }): RepairFilingInsertResult {
    this.insertCalls.push(input);
    if (this.insertError) throw this.insertError;
    const key = `${input.kind}:${input.subject}:${input.stateSha}`;
    if (this.claimedKeys.has(key)) return { inserted: false };
    this.claimedKeys.add(key);
    this.rows = [...this.rows, { ...input, createdAt: new Date().toISOString() }];
    return { inserted: true };
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

  it('files one investigation for a fresh e2e-regression needs-human finding and claims the investigated marker', async () => {
    const needsHumanRow: RepairFilingRow = {
      kind: `${E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX}playwright-5-of-9:job-level`,
      subject: 'Neko-Catpital-Labs/Invoker',
      stateSha: 'sha-capped',
      createdAt: new Date().toISOString(),
    };
    const repairFilings = new FakeRepairFilingStore([needsHumanRow]);
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store } = makeDecisionStore();

    await runAdminBypassE2eBabysitTick({
      logger: makeLogger(),
      workerLifecycle: new FakeWorkerLifecycle([]),
      repairFilings,
      planSubmitter,
      store,
    });

    expect(repairFilings.insertCalls).toEqual([{
      kind: `${E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX}playwright-5-of-9:job-level`,
      subject: needsHumanRow.subject,
      stateSha: needsHumanRow.stateSha,
    }]);
    expect(planSubmitter.submittedPlans).toHaveLength(1);
    expect(planSubmitter.submittedPlans[0]).toContain(needsHumanRow.kind);
    expect(planSubmitter.submittedPlans[0]).toContain(needsHumanRow.stateSha);
    expect(planSubmitter.submittedPlans[0]).toContain('needsHuman');
  });

  it('does not re-file an investigation for a needs-human finding already marked investigated', async () => {
    const needsHumanRow: RepairFilingRow = {
      kind: `${E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX}playwright-5-of-9:job-level`,
      subject: 'Neko-Catpital-Labs/Invoker',
      stateSha: 'sha-capped',
      createdAt: new Date().toISOString(),
    };
    const investigatedRow: RepairFilingRow = {
      kind: `${E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX}playwright-5-of-9:job-level`,
      subject: needsHumanRow.subject,
      stateSha: needsHumanRow.stateSha,
      createdAt: new Date().toISOString(),
    };
    const repairFilings = new FakeRepairFilingStore([needsHumanRow, investigatedRow]);
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store } = makeDecisionStore();

    await runAdminBypassE2eBabysitTick({
      logger: makeLogger(),
      workerLifecycle: new FakeWorkerLifecycle([]),
      repairFilings,
      planSubmitter,
      store,
    });

    expect(repairFilings.insertCalls).toEqual([]);
    expect(planSubmitter.submittedPlans).toHaveLength(0);
  });

  it('logs and records a failed needs-human claim without throwing or filing a duplicate later', async () => {
    const needsHumanRow: RepairFilingRow = {
      kind: `${E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX}flaky-job:job-level`,
      subject: 'Neko-Catpital-Labs/Invoker',
      stateSha: 'sha-capped-2',
      createdAt: new Date().toISOString(),
    };
    const logger = makeLogger();
    const repairFilings = new FakeRepairFilingStore([needsHumanRow], undefined, new Error('insert failed'));
    const planSubmitter = new FakeInvestigativePlanSubmitter();
    const { store, rows } = makeDecisionStore();

    await expect(runAdminBypassE2eBabysitTick({
      logger,
      workerLifecycle: new FakeWorkerLifecycle([]),
      repairFilings,
      planSubmitter,
      store,
    })).resolves.toBeUndefined();

    expect(logger.error).toHaveBeenCalled();
    expect(planSubmitter.submittedPlans).toHaveLength(0);
    expect(rows).toContainEqual({
      subjectId: `${needsHumanRow.kind}:${needsHumanRow.subject}:${needsHumanRow.stateSha}`,
      status: 'failed',
    });
  });
});

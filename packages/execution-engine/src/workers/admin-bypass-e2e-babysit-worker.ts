import type { Logger } from '@invoker/contracts';

import { recordWorkerDecisionRow, type WorkerDecisionStore } from '../worker-decision-ledger.js';
import type { WorkerRuntimeDependencies } from '../worker-runtime-dependencies.js';
import type { WorkerRegistry } from '../worker-registry.js';
import { createWorkerRuntime, type WorkerRuntime, type WorkerTick } from '../worker-runtime.js';

export const ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND = 'admin-bypass-e2e-babysit';

export const REPAIR_FILING_STALE_TTL_MS = 5_400_000;

export const DEFAULT_WATCHED_WORKER_KINDS = [
  'pr-admin-bypass-land',
  'e2e-autofix',
  'claude-oauth-refresh',
] as const;

/**
 * Prefix for repair_filings rows scripts/e2e-regression-watch.mjs inserts
 * (via claimNeedsHumanRepairFiling) when a failure exhausts its automated
 * fix-attempt retry budget. Matches needsHumanRepairFilingKind() there.
 */
export const E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX = 'ci-regression-needs-human:';

/**
 * Prefix for the companion claim this worker inserts once it has filed an
 * investigation for a given needs-human row, so a later tick does not
 * re-file for the same (subject, stateSha) every cycle.
 */
export const E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX = 'ci-regression-needs-human-investigated:';

const DEFAULT_INTERVAL_MS = 10 * 60_000;

export interface WorkerLifecycleSnapshot {
  readonly kind: string;
  readonly desiredEnabled: boolean;
  readonly lifecycle: 'running' | 'stopped' | 'exited';
}

export interface WorkerLifecycleReader {
  listWorkers(): readonly WorkerLifecycleSnapshot[] | Promise<readonly WorkerLifecycleSnapshot[]>;
}

export interface WorkerLifecycleStarter {
  start(kind: string): unknown;
}

export interface RepairFilingRow {
  readonly kind: string;
  readonly subject: string;
  readonly stateSha: string;
  readonly createdAt: string;
}

export interface RepairFilingInsertResult {
  readonly inserted: boolean;
}

export interface RepairFilingStore {
  listRepairFilings(): readonly RepairFilingRow[] | Promise<readonly RepairFilingRow[]>;
  deleteRepairFiling(kind: string, subject: string, stateSha: string): unknown;
  insertRepairFiling(input: {
    kind: string;
    subject: string;
    stateSha: string;
  }): RepairFilingInsertResult | Promise<RepairFilingInsertResult>;
}

export interface InvestigativePlanSubmitter {
  submitPlan(planText: string): unknown;
}

export interface AdminBypassE2eBabysitWorkerConfig {
  enabled?: boolean;
  intervalMs?: number;
  tickOnStart?: boolean;
  watchedWorkerKinds?: readonly string[];
  staleTtlMs?: number;
  store?: WorkerDecisionStore;
  onTick?: WorkerTick;
}

export interface AdminBypassE2eBabysitWorkerOptions {
  logger: Logger;
  intervalMs?: number;
  tickOnStart?: boolean;
  watchedWorkerKinds?: readonly string[];
  staleTtlMs?: number;
  workerLifecycle: WorkerLifecycleReader & WorkerLifecycleStarter;
  repairFilings: RepairFilingStore;
  planSubmitter: InvestigativePlanSubmitter;
  store?: WorkerDecisionStore;
  onTick?: WorkerTick;
}

export type AdminBypassE2eBabysitAction =
  | {
      readonly type: 'worker-start';
      readonly kind: string;
    }
  | {
      readonly type: 'repair-filing-delete';
      readonly kind: string;
      readonly subject: string;
      readonly stateSha: string;
      readonly createdAt: string;
    }
  | {
      readonly type: 'e2e-regression-needs-human';
      readonly kind: string;
      readonly subject: string;
      readonly stateSha: string;
    };

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function investigativePrompt(action: AdminBypassE2eBabysitAction): string {
  if (action.type === 'worker-start') {
    return (
      'Assume zero prior context. Investigate a production worker-lifecycle finding: '
      + `worker kind ${JSON.stringify(action.kind)} was desiredEnabled=true but lifecycle=stopped, `
      + 'so the admin-bypass-e2e-babysit worker attempted to start it. Determine what caused this state '
      + 'and what would durably prevent recurrence. Support conclusions with evidence and propose a concrete prevention.'
    );
  }
  if (action.type === 'repair-filing-delete') {
    return (
      'Assume zero prior context. Investigate a production repair-filings finding: '
      + `the admin-bypass-e2e-babysit worker attempted to delete a stale repair_filings row with kind `
      + `${JSON.stringify(action.kind)}, subject ${JSON.stringify(action.subject)}, stateSha `
      + `${JSON.stringify(action.stateSha)}, and createdAt ${JSON.stringify(action.createdAt)}. `
      + 'Determine what caused the claim to remain stale and what would durably prevent recurrence. '
      + 'Support conclusions with evidence and propose a concrete prevention.'
    );
  }
  return (
    'Assume zero prior context. Investigate a production e2e-regression-watch finding: '
    + `scripts/e2e-regression-watch.mjs exhausted its automated fix-attempt retry budget and marked a `
    + `failure needsHuman -- repair_filings kind ${JSON.stringify(action.kind)}, subject `
    + `${JSON.stringify(action.subject)}, first-bad stateSha ${JSON.stringify(action.stateSha)}. `
    + 'Determine why the automated fix attempts did not land (read the actual CI job log and any repair '
    + 'PR history for this failure) and propose a concrete fix or escalation. '
    + 'Support conclusions with evidence.'
  );
}

export function buildInvestigativePlanYaml(actions: readonly AdminBypassE2eBabysitAction[]): string {
  const taskLines = actions.flatMap((action, index) => {
    const prompt = investigativePrompt(action);
    return [
      `  - id: investigate-finding-${index + 1}`,
      `    description: ${yamlString(prompt)}`,
      `    prompt: ${yamlString(prompt)}`,
      '    dependencies: []',
    ];
  });
  return [
    'name: "Investigate admin-bypass e2e babysit intervention"',
    'scratch: true',
    'onFinish: none',
    'mergeMode: no_op',
    '',
    'tasks:',
    ...taskLines,
    '',
  ].join('\n');
}

function recordDecision(
  store: WorkerDecisionStore | undefined,
  row: {
    actionType: string;
    externalKey: string;
    subjectType: string;
    subjectId: string;
    status: 'completed' | 'failed';
    summary: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!store) return;
  recordWorkerDecisionRow(store, {
    workerKind: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
    ...row,
  });
}

export async function runAdminBypassE2eBabysitTick(
  options: AdminBypassE2eBabysitWorkerOptions,
): Promise<void> {
  const actions: AdminBypassE2eBabysitAction[] = [];
  const watchedWorkerKinds = new Set(options.watchedWorkerKinds ?? DEFAULT_WATCHED_WORKER_KINDS);
  const workers = await options.workerLifecycle.listWorkers();

  for (const worker of workers) {
    if (!watchedWorkerKinds.has(worker.kind)) continue;
    if (worker.desiredEnabled !== true || worker.lifecycle !== 'stopped') continue;

    actions.push({ type: 'worker-start', kind: worker.kind });
    try {
      await options.workerLifecycle.start(worker.kind);
      options.logger.info(`[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] started stopped desired-enabled worker`, {
        module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
        kind: worker.kind,
      });
      recordDecision(options.store, {
        actionType: 'start-worker',
        externalKey: `worker:${worker.kind}`,
        subjectType: 'worker',
        subjectId: worker.kind,
        status: 'completed',
        summary: `Started desired-enabled stopped worker ${worker.kind}`,
        payload: { kind: worker.kind },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger.error(
        `[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] failed to start worker ${worker.kind}: ${detail}`,
        { module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND, kind: worker.kind },
      );
      recordDecision(options.store, {
        actionType: 'start-worker',
        externalKey: `worker:${worker.kind}`,
        subjectType: 'worker',
        subjectId: worker.kind,
        status: 'failed',
        summary: `Failed to start desired-enabled stopped worker ${worker.kind}: ${detail}`,
        payload: { kind: worker.kind, error: detail },
      });
    }
  }

  const staleTtlMs = options.staleTtlMs ?? REPAIR_FILING_STALE_TTL_MS;
  const repairFilings = await options.repairFilings.listRepairFilings();
  for (const row of repairFilings) {
    if (!(Date.now() - Date.parse(row.createdAt) > staleTtlMs)) continue;

    const subjectId = `${row.kind}:${row.subject}:${row.stateSha}`;
    actions.push({
      type: 'repair-filing-delete',
      kind: row.kind,
      subject: row.subject,
      stateSha: row.stateSha,
      createdAt: row.createdAt,
    });
    try {
      await options.repairFilings.deleteRepairFiling(row.kind, row.subject, row.stateSha);
      options.logger.info(`[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] deleted stale repair filing`, {
        module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
        kind: row.kind,
        subject: row.subject,
        stateSha: row.stateSha,
        createdAt: row.createdAt,
      });
      recordDecision(options.store, {
        actionType: 'delete-stale-repair-filing',
        externalKey: `repair-filing:${subjectId}`,
        subjectType: 'repair-filing',
        subjectId,
        status: 'completed',
        summary: `Deleted stale repair filing ${subjectId}`,
        payload: { ...row, staleTtlMs },
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger.error(
        `[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] failed to delete stale repair filing ${subjectId}: ${detail}`,
        {
          module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
          kind: row.kind,
          subject: row.subject,
          stateSha: row.stateSha,
          createdAt: row.createdAt,
        },
      );
      recordDecision(options.store, {
        actionType: 'delete-stale-repair-filing',
        externalKey: `repair-filing:${subjectId}`,
        subjectType: 'repair-filing',
        subjectId,
        status: 'failed',
        summary: `Failed to delete stale repair filing ${subjectId}: ${detail}`,
        payload: { ...row, staleTtlMs, error: detail },
      });
    }
  }

  const needsHumanRows = repairFilings.filter((row) => row.kind.startsWith(E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX));
  const alreadyInvestigatedKeys = new Set(
    repairFilings
      .filter((row) => row.kind.startsWith(E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX))
      .map((row) => `${row.subject}:${row.stateSha}`),
  );
  for (const row of needsHumanRows) {
    const dedupeKey = `${row.subject}:${row.stateSha}`;
    if (alreadyInvestigatedKeys.has(dedupeKey)) continue;

    const investigatedKind = E2E_REGRESSION_NEEDS_HUMAN_INVESTIGATED_KIND_PREFIX
      + row.kind.slice(E2E_REGRESSION_NEEDS_HUMAN_KIND_PREFIX.length);
    const subjectId = `${row.kind}:${row.subject}:${row.stateSha}`;
    let claim: RepairFilingInsertResult;
    try {
      claim = await options.repairFilings.insertRepairFiling({
        kind: investigatedKind,
        subject: row.subject,
        stateSha: row.stateSha,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      options.logger.error(
        `[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] failed to claim e2e-regression needs-human finding ${subjectId}: ${detail}`,
        { module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND, kind: row.kind, subject: row.subject, stateSha: row.stateSha },
      );
      recordDecision(options.store, {
        actionType: 'e2e-regression-needs-human',
        externalKey: `repair-filing:${subjectId}`,
        subjectType: 'repair-filing',
        subjectId,
        status: 'failed',
        summary: `Failed to claim e2e-regression needs-human finding ${subjectId}: ${detail}`,
        payload: { ...row, error: detail },
      });
      continue;
    }
    // Another concurrent tick already claimed and is filing this one.
    if (!claim.inserted) continue;

    actions.push({
      type: 'e2e-regression-needs-human',
      kind: row.kind,
      subject: row.subject,
      stateSha: row.stateSha,
    });
    options.logger.info(`[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] filing investigation for e2e-regression needs-human finding`, {
      module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
      kind: row.kind,
      subject: row.subject,
      stateSha: row.stateSha,
    });
    recordDecision(options.store, {
      actionType: 'e2e-regression-needs-human',
      externalKey: `repair-filing:${subjectId}`,
      subjectType: 'repair-filing',
      subjectId,
      status: 'completed',
      summary: `Filed investigation for e2e-regression needs-human finding ${subjectId}`,
      payload: { ...row },
    });
  }

  if (actions.length === 0) return;
  try {
    await options.planSubmitter.submitPlan(buildInvestigativePlanYaml(actions));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    options.logger.error(
      `[${ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND}] failed to submit investigative plan: ${detail}`,
      { module: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND, actionCount: actions.length },
    );
  }
}

export function createAdminBypassE2eBabysitWorker(
  config: AdminBypassE2eBabysitWorkerConfig & {
    logger: Logger;
    workerLifecycle: WorkerLifecycleReader & WorkerLifecycleStarter;
    repairFilings: RepairFilingStore;
    planSubmitter: InvestigativePlanSubmitter;
  },
): WorkerRuntime {
  const options: AdminBypassE2eBabysitWorkerOptions = {
    logger: config.logger,
    intervalMs: config.intervalMs,
    tickOnStart: config.tickOnStart,
    watchedWorkerKinds: config.watchedWorkerKinds,
    staleTtlMs: config.staleTtlMs,
    workerLifecycle: config.workerLifecycle,
    repairFilings: config.repairFilings,
    planSubmitter: config.planSubmitter,
    store: config.store,
  };
  const onTick: WorkerTick = config.onTick ?? (async () => {
    await runAdminBypassE2eBabysitTick(options);
  });
  return createWorkerRuntime({
    kind: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
    logger: config.logger,
    onTick,
    intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
    tickOnStart: config.tickOnStart ?? true,
  });
}

export function registerAdminBypassE2eBabysitWorker(
  registry: WorkerRegistry<WorkerRuntimeDependencies>,
): WorkerRegistry<WorkerRuntimeDependencies> {
  registry.register({
    kind: ADMIN_BYPASS_E2E_BABYSIT_WORKER_KIND,
    note: 'Restarts desired-enabled watched workers and expires stale repair-filing claims, then files investigations.',
    source: 'built-in',
    factory: (deps: WorkerRuntimeDependencies): WorkerRuntime => {
      const config = deps.adminBypassE2eBabysit ?? {};
      if (!deps.workerLifecycleStarter || !deps.repairFilingStore || !deps.investigativePlanSubmitter) {
        throw new Error('admin-bypass-e2e-babysit worker dependencies are not wired');
      }
      return createAdminBypassE2eBabysitWorker({
        logger: deps.logger,
        ...config,
        workerLifecycle: deps.workerLifecycleStarter,
        repairFilings: deps.repairFilingStore,
        planSubmitter: deps.investigativePlanSubmitter,
        store: config.store ?? deps.store,
      });
    },
  });
  return registry;
}

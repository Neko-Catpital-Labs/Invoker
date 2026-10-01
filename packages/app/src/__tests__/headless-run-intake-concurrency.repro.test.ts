import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { afterEach, describe, expect, it } from 'vitest';

const INTAKE_COUNT = 10;
const CONTROLLED_REPRO_RUN = process.env.INVOKER_REPRO_EXPECT === 'bug' || process.env.INVOKER_REPRO_EXPECT === 'fixed';

type IntakeAck = {
  name: string;
  workflowId: string | undefined;
};

type IntakeReport = {
  measured: string;
  lostNames: string[];
  doubledNames: string[];
  unnamedRowIds: string[];
  ackedWithoutId: string[];
  misattributed: string[];
  sharedAckIds: string[];
  orphanedWorkflowIds: string[];
};

function intakeNames(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `Intake Concurrency ${String(index + 1).padStart(2, '0')}`,
  );
}

function formatList(values: string[]): string {
  return values.length === 0 ? 'none' : values.slice(0, 10).join(',');
}

function planFor(name: string) {
  return {
    name,
    repoUrl: 'file:///tmp/headless-run-intake-concurrency',
    tasks: [{ id: 'root', description: `${name} root task`, command: `printf '${name}\\n'` }],
  };
}

async function yieldToPeers(): Promise<void> {
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 0));
}

async function intakeWithSnapshotDiffAttribution(
  orchestrator: Orchestrator,
  name: string,
): Promise<IntakeAck> {
  const existingWorkflowIds = new Set(orchestrator.getWorkflowIds());
  await yieldToPeers();
  orchestrator.loadPlan(planFor(name));
  const workflowId = orchestrator.getWorkflowIds().find((id) => !existingWorkflowIds.has(id));
  return { name, workflowId };
}

async function intakeWithOwnLoadPlanResult(
  orchestrator: Orchestrator,
  name: string,
): Promise<IntakeAck> {
  await yieldToPeers();
  const workflowId = orchestrator.loadPlan(planFor(name));
  return { name, workflowId };
}

function inspectIntakes(
  persistence: SQLiteAdapter,
  expectedNames: string[],
  acks: IntakeAck[],
): IntakeReport {
  const storedCounts = new Map<string, number>();
  const nameByWorkflowId = new Map<string, string>();
  const unnamedRowIds: string[] = [];
  for (const workflow of persistence.listWorkflows()) {
    if (!workflow.name) {
      unnamedRowIds.push(workflow.id);
      continue;
    }
    nameByWorkflowId.set(workflow.id, workflow.name);
    storedCounts.set(workflow.name, (storedCounts.get(workflow.name) ?? 0) + 1);
  }

  const lostNames = expectedNames.filter((name) => (storedCounts.get(name) ?? 0) === 0);
  const doubledNames = expectedNames.filter((name) => (storedCounts.get(name) ?? 0) > 1);
  const ackedWithoutId = acks.filter((ack) => ack.workflowId === undefined).map((ack) => ack.name);
  const misattributed = acks
    .filter((ack) => ack.workflowId !== undefined && nameByWorkflowId.get(ack.workflowId) !== ack.name)
    .map((ack) => `${ack.name}->${nameByWorkflowId.get(ack.workflowId!) ?? '<absent>'}`);

  const ackCountById = new Map<string, number>();
  for (const ack of acks) {
    if (ack.workflowId === undefined) continue;
    ackCountById.set(ack.workflowId, (ackCountById.get(ack.workflowId) ?? 0) + 1);
  }
  const sharedAckIds = [...ackCountById.entries()].filter(([, count]) => count > 1).map(([id]) => id);
  const ackedIds = new Set(ackCountById.keys());
  const orphanedWorkflowIds = [...nameByWorkflowId.keys()].filter((id) => !ackedIds.has(id));

  const measured = [
    `intakes=${expectedNames.length}`,
    `storedNames=${storedCounts.size}`,
    `lost=${formatList(lostNames)}`,
    `doubled=${formatList(doubledNames)}`,
    `unnamedRows=${formatList(unnamedRowIds)}`,
    `ackedWithoutId=${formatList(ackedWithoutId)}`,
    `misattributed=${formatList(misattributed)}`,
    `sharedAckIds=${formatList(sharedAckIds)}`,
    `orphanedWorkflowIds=${formatList(orphanedWorkflowIds)}`,
  ].join(' ');

  return {
    measured,
    lostNames,
    doubledNames,
    unnamedRowIds,
    ackedWithoutId,
    misattributed,
    sharedAckIds,
    orphanedWorkflowIds,
  };
}

async function openOrchestrator(
  tempDirs: string[],
  prefix: string,
): Promise<{ orchestrator: Orchestrator; store: SQLiteAdapter }> {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  const store = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
  const orchestrator = new Orchestrator({
    persistence: store,
    messageBus: new InMemoryBus(),
    maxConcurrency: 1,
    resolveRepoDefaultBranch: () => 'master',
  });
  return { orchestrator, store };
}

describe('headless run intake concurrency contract', () => {
  const tempDirs: string[] = [];
  let persistence: SQLiteAdapter | undefined;

  afterEach(() => {
    persistence?.close();
    persistence = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('persists every overlapping intake name exactly once', async () => {
    const { orchestrator, store } = await openOrchestrator(tempDirs, 'headless-intake-concurrency-');
    persistence = store;
    const names = intakeNames(INTAKE_COUNT);

    const acks = await Promise.all(names.map((name) => intakeWithOwnLoadPlanResult(orchestrator, name)));
    const report = inspectIntakes(store, names, acks);
    console.error(`[headless-run-intake-concurrency] loadPlanResult ${report.measured}`);

    expect(report.lostNames, `overlapping intake lost plan names; ${report.measured}`).toEqual([]);
    expect(report.doubledNames, `overlapping intake duplicated plan names; ${report.measured}`).toEqual([]);
    expect(report.unnamedRowIds, `a stored workflow with no name cannot be checked for exact-once; ${report.measured}`).toEqual([]);
  });

  it('acknowledges each overlapping intake with the id of its own workflow', async () => {
    const { orchestrator, store } = await openOrchestrator(tempDirs, 'headless-intake-concurrency-');
    persistence = store;
    const names = intakeNames(INTAKE_COUNT);

    const acks = await Promise.all(names.map((name) => intakeWithOwnLoadPlanResult(orchestrator, name)));
    const report = inspectIntakes(store, names, acks);
    console.error(`[headless-run-intake-concurrency] attribution ${report.measured}`);

    expect(report.ackedWithoutId, `every intake ack must carry a workflow id; ${report.measured}`).toEqual([]);
    expect(report.misattributed, `an intake ack must name its own workflow; ${report.measured}`).toEqual([]);
    expect(report.sharedAckIds, `two intakes must not ack the same workflow id; ${report.measured}`).toEqual([]);
    expect(report.orphanedWorkflowIds, `every stored workflow must be acked to some intake; ${report.measured}`).toEqual([]);
  });
});

describe.skipIf(!CONTROLLED_REPRO_RUN)('headless run intake snapshot-diff attribution under overlap (repro)', () => {
  const tempDirs: string[] = [];
  let persistence: SQLiteAdapter | undefined;

  afterEach(() => {
    persistence?.close();
    persistence = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('resolves each intake to its own workflow instead of a peer intake workflow', async () => {
    const { orchestrator, store } = await openOrchestrator(tempDirs, 'headless-intake-snapshot-diff-');
    persistence = store;
    const names = intakeNames(INTAKE_COUNT);

    const acks = await Promise.all(names.map((name) => intakeWithSnapshotDiffAttribution(orchestrator, name)));
    const report = inspectIntakes(store, names, acks);
    console.error(`[headless-run-intake-concurrency] snapshotDiff ${report.measured}`);

    if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
      const hasDefect = report.misattributed.length > 0
        || report.sharedAckIds.length > 0
        || report.orphanedWorkflowIds.length > 0
        || report.ackedWithoutId.length > 0;
      expect(hasDefect, `expected snapshot-diff attribution to misattribute an overlapping intake; ${report.measured}`).toBe(true);
      return;
    }

    expect(report.lostNames, `overlapping intake lost plan names; ${report.measured}`).toEqual([]);
    expect(report.doubledNames, `overlapping intake duplicated plan names; ${report.measured}`).toEqual([]);
    expect(report.ackedWithoutId, `every intake ack must carry a workflow id; ${report.measured}`).toEqual([]);
    expect(report.misattributed, `an intake ack must name its own workflow; ${report.measured}`).toEqual([]);
    expect(report.sharedAckIds, `two intakes must not ack the same workflow id; ${report.measured}`).toEqual([]);
    expect(report.orphanedWorkflowIds, `every stored workflow must be acked to some intake; ${report.measured}`).toEqual([]);
  });
});

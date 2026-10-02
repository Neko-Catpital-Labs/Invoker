import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

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

type HandlerIntakeAck = IntakeAck & {
  storedName: string | undefined;
  storedTaskCount: number;
  ackedTaskCount: number;
};

type HandlerFixture = {
  tmpDir: string;
  repoUrl: string;
  adapter: SQLiteAdapter;
  taskHandles: Map<string, unknown>;
  handlerScans: { listWorkflows: number };
  actions: {
    executeHeadlessRun: (payload: { planPath: string; noTrack?: boolean; forceSynchronousAck?: boolean }) => Promise<{
      workflowId: string;
      tasks: unknown[];
      workflowIds: string[];
      workflowCount: number;
      planName: string;
    }>;
  };
};

const silentLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return silentLogger; },
};

function writeIntakePlan(tmpDir: string, repoUrl: string, name: string): string {
  const planPath = join(tmpDir, `${name.replace(/\s+/g, '-').toLowerCase()}.yaml`);
  writeFileSync(planPath, [
    `name: ${name}`,
    `repoUrl: ${repoUrl}`,
    'tasks:',
    '  - id: root',
    `    description: ${name} root task`,
    '    command: "true"',
    '',
  ].join('\n'));
  return planPath;
}

function writeStackPlanWithFailingSecondWorkflow(tmpDir: string, repoUrl: string): string {
  const planPath = join(tmpDir, 'failing-stack.yaml');
  writeFileSync(planPath, [
    'name: Failing Intake Stack',
    `repoUrl: ${repoUrl}`,
    'workflows:',
    '  - name: Failing Stack Parent',
    '    tasks:',
    '      - id: parent',
    '        description: Parent task',
    '        command: "true"',
    '  - name: Failing Stack Child',
    '    externalDependencies:',
    '      - workflowId: wf-missing-upstream',
    '        taskId: __merge__',
    '    tasks:',
    '      - id: child',
    '        description: Child task',
    '        command: "true"',
    '',
  ].join('\n'));
  return planPath;
}

function countWorkflowTableScans(
  adapter: SQLiteAdapter,
  counts: { listWorkflows: number },
): SQLiteAdapter {
  return new Proxy(adapter, {
    get(target, property, receiver) {
      if (property === 'listWorkflows') {
        return (...args: unknown[]) => {
          counts.listWorkflows += 1;
          return (target.listWorkflows as (...inner: unknown[]) => unknown)(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as SQLiteAdapter;
}

async function createHandlerFixture(tempDirs: string[]): Promise<HandlerFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'headless-intake-handler-'));
  tempDirs.push(tmpDir);
  const homeDir = join(tmpDir, 'home');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('INVOKER_DB_DIR', join(homeDir, '.invoker'));
  vi.stubEnv('INVOKER_REPO_CONFIG_PATH', join(homeDir, '.invoker', 'config.json'));

  const { createGuiMutationTaskActions } = await import('../ipc/gui-mutation-handlers.js');
  const repoUrl = join(tmpDir, 'repo.git');
  execFileSync('git', ['init', '--bare', repoUrl], { stdio: 'ignore' });

  const adapter = await SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
  const messageBus = new InMemoryBus();
  let orchestrator = new Orchestrator({
    persistence: adapter as never,
    messageBus,
    maxConcurrency: 1,
    logger: silentLogger as never,
    resolveRepoDefaultBranch: () => 'master',
  });
  orchestrator.syncAllFromDb();

  const taskHandles = new Map<string, unknown>();
  const handlerScans = { listWorkflows: 0 };
  const context = {
    logger: silentLogger,
    persistence: countWorkflowTableScans(adapter, handlerScans),
    messageBus,
    executorRegistry: {},
    agentRegistry: {},
    repoRoot: tmpDir,
    invokerConfig: { allowGraphMutation: false },
    effectiveMaxConcurrency: 1,
    taskHandles,
    getOrchestrator: () => orchestrator,
    setOrchestrator: (next: typeof orchestrator) => { orchestrator = next; },
    getCommandService: () => ({}),
    setCommandService: () => {},
    getWorkflowMutationCoordinator: () => null,
    workflowMutationDispatcher: new Map(),
    getActiveMutationContext: () => undefined,
    getRendererTaskFeed: () => ({}),
    getStartupWorkflowId: () => null,
    getLaunchDispatcher: () => null,
    requireTaskExecutor: () => ({}),
    getTaskExecutor: () => null,
    rebuildTaskRunner: () => {},
    initServices: async () => {},
    requestWorkflowMetadataPublish: () => {},
    cancelDeferredWorkflowLaunch: () => {},
    killRunningTask: async () => {},
    buildCommandServiceInvalidationDeps: () => ({}),
  };

  return {
    tmpDir,
    repoUrl,
    adapter,
    taskHandles,
    handlerScans,
    actions: createGuiMutationTaskActions(context as never) as HandlerFixture['actions'],
  };
}

async function intakeThroughHandler(
  fixture: HandlerFixture,
  planPath: string,
  name: string,
): Promise<HandlerIntakeAck> {
  const result = await fixture.actions.executeHeadlessRun({ planPath });
  const stored = fixture.adapter.loadWorkflow(result.workflowId);
  const storedTasks = result.workflowId ? fixture.adapter.loadTasks(result.workflowId) : [];
  return {
    name,
    workflowId: result.workflowId,
    storedName: stored?.name,
    storedTaskCount: storedTasks.length,
    ackedTaskCount: result.tasks.length,
  };
}

describe('headless run intake concurrency contract (executeHeadlessRun handler)', () => {
  const tempDirs: string[] = [];
  let fixture: HandlerFixture | undefined;

  afterEach(() => {
    fixture?.adapter.close();
    fixture = undefined;
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  it('acks every overlapping intake with its own already-persisted workflow', async () => {
    fixture = await createHandlerFixture(tempDirs);
    const names = intakeNames(INTAKE_COUNT);
    const planPaths = names.map((name) => writeIntakePlan(fixture!.tmpDir, fixture!.repoUrl, name));

    const acks = await Promise.all(
      names.map((name, index) => intakeThroughHandler(fixture!, planPaths[index]!, name)),
    );
    const report = inspectIntakes(fixture.adapter, names, acks);
    console.error(`[headless-run-intake-concurrency] handler ${report.measured}`);

    expect(report.ackedWithoutId, `every intake ack must carry a workflow id; ${report.measured}`).toEqual([]);
    expect(report.lostNames, `overlapping intake lost plan names; ${report.measured}`).toEqual([]);
    expect(report.doubledNames, `overlapping intake duplicated plan names; ${report.measured}`).toEqual([]);
    expect(report.misattributed, `an intake ack must name its own workflow; ${report.measured}`).toEqual([]);
    expect(report.sharedAckIds, `two intakes must not ack the same workflow id; ${report.measured}`).toEqual([]);
    expect(report.orphanedWorkflowIds, `every stored workflow must be acked to some intake; ${report.measured}`).toEqual([]);

    const unreadableAtAck = acks.filter((ack) => ack.storedName !== ack.name).map((ack) => `${ack.name}->${ack.storedName ?? '<absent>'}`);
    const ackedWithoutTasks = acks.filter((ack) => ack.storedTaskCount === 0 || ack.ackedTaskCount === 0).map((ack) => ack.name);
    expect(unreadableAtAck, `a successful ack must name a workflow row already readable from persistence; ${report.measured}`).toEqual([]);
    expect(ackedWithoutTasks, `a successful ack must have its tasks persisted before it returns; ${report.measured}`).toEqual([]);
  });

  it('resolves each intake by keyed read instead of scanning the workflow table', async () => {
    fixture = await createHandlerFixture(tempDirs);
    const names = intakeNames(INTAKE_COUNT);
    const planPaths = names.map((name) => writeIntakePlan(fixture!.tmpDir, fixture!.repoUrl, name));

    await Promise.all(names.map((name, index) => intakeThroughHandler(fixture!, planPaths[index]!, name)));

    expect(
      fixture.handlerScans.listWorkflows,
      `intake must not scan the whole workflow table before acking; scans=${fixture.handlerScans.listWorkflows} intakes=${names.length}`,
    ).toBe(0);
  });

  it('noTrack acks only after the reserved workflow is persisted', async () => {
    fixture = await createHandlerFixture(tempDirs);
    const planPath = writeIntakePlan(fixture.tmpDir, fixture.repoUrl, 'No Track Persisted Ack');

    const result = await fixture.actions.executeHeadlessRun({ planPath, noTrack: true });

    expect(result.tasks).toEqual([]);
    expect(result.workflowIds).toEqual([result.workflowId]);
    expect(fixture.adapter.loadWorkflow(result.workflowId)?.name).toBe('No Track Persisted Ack');
    expect(fixture.adapter.loadTasks(result.workflowId)).toHaveLength(2);
  });

  it('rolls back earlier stack workflows when a noTrack submission fails before ack', async () => {
    fixture = await createHandlerFixture(tempDirs);
    const planPath = writeStackPlanWithFailingSecondWorkflow(fixture.tmpDir, fixture.repoUrl);

    await expect(
      fixture.actions.executeHeadlessRun({ planPath, noTrack: true }),
    ).rejects.toThrow(/missing cross-workflow prerequisites/);

    expect(fixture.adapter.listWorkflows()).toEqual([]);
  });

  it('leaves another intake\'s in-flight task handles alone', async () => {
    fixture = await createHandlerFixture(tempDirs);
    const names = intakeNames(INTAKE_COUNT);
    const planPaths = names.map((name) => writeIntakePlan(fixture!.tmpDir, fixture!.repoUrl, name));
    const peerHandle = { taskId: 'peer-intake/root' };
    fixture.taskHandles.set(peerHandle.taskId, peerHandle);

    await Promise.all(names.map((name, index) => intakeThroughHandler(fixture!, planPaths[index]!, name)));

    expect(
      fixture.taskHandles.get(peerHandle.taskId),
      'an overlapping intake must not drop a peer task handle, or its terminal and cancel paths lose the running task',
    ).toBe(peerHandle);
  });
});

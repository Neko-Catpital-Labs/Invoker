import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SAMPLE_COUNT = 5;
const BUDGET_MS = 200;
const LARGE_WORKFLOW_COUNT = Number(process.env.INVOKER_REPRO_WORKFLOW_COUNT ?? '1000');
const TASKS_PER_SEEDED_WORKFLOW = 5;

type LoadedModules = {
  SQLiteAdapter: typeof import('@invoker/data-store').SQLiteAdapter;
  InMemoryBus: typeof import('@invoker/test-kit').InMemoryBus;
  Orchestrator: typeof import('@invoker/workflow-core').Orchestrator;
  createGuiMutationTaskActions: typeof import('../ipc/gui-mutation-handlers.js').createGuiMutationTaskActions;
  resolveTaskConfig: typeof import('@invoker/workflow-core').resolveTaskConfig;
};

type OwnerFixture = {
  tmpDir: string;
  homeDir: string;
  repoUrl: string;
  adapter: Awaited<ReturnType<LoadedModules['SQLiteAdapter']['create']>>;
  actions: ReturnType<LoadedModules['createGuiMutationTaskActions']>;
};

type Measurement = {
  workflowCount: number;
  samples: number[];
  p50: number;
  max: number;
};

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return logger; },
};

let fixture: OwnerFixture | undefined;

function percentile50(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function max(samples: number[]): number {
  return Math.max(...samples);
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function formatMeasurement(measurement: Measurement): string {
  return [
    `N=${measurement.workflowCount}`,
    `samples=[${measurement.samples.map(formatMs).join(', ')}]`,
    `p50=${formatMs(measurement.p50)}ms`,
    `max=${formatMs(measurement.max)}ms`,
    `budget=${BUDGET_MS}ms`,
  ].join(' ');
}

async function loadModules(): Promise<LoadedModules> {
  const [
    dataStore,
    testKit,
    workflowCore,
    guiMutationHandlers,
  ] = await Promise.all([
    import('@invoker/data-store'),
    import('@invoker/test-kit'),
    import('@invoker/workflow-core'),
    import('../ipc/gui-mutation-handlers.js'),
  ]);
  return {
    SQLiteAdapter: dataStore.SQLiteAdapter,
    InMemoryBus: testKit.InMemoryBus,
    Orchestrator: workflowCore.Orchestrator,
    createGuiMutationTaskActions: guiMutationHandlers.createGuiMutationTaskActions,
    resolveTaskConfig: workflowCore.resolveTaskConfig,
  };
}

function writePlan(tmpDir: string, repoUrl: string, label: string): string {
  const planPath = join(tmpDir, `${label}.yaml`);
  writeFileSync(planPath, [
    `name: Submit Latency ${label}`,
    `repoUrl: ${repoUrl}`,
    'tasks:',
    `  - id: intake-${label}`,
    `    description: Measure intake ${label}`,
    '    command: "true"',
    '',
  ].join('\n'));
  return planPath;
}

function seedWorkflows(
  adapter: OwnerFixture['adapter'],
  resolveTaskConfig: LoadedModules['resolveTaskConfig'],
  workflowCount: number,
): void {
  const nowIso = new Date().toISOString();
  const createdAt = new Date(nowIso);
  adapter.runInTransaction(() => {
    for (let i = 0; i < workflowCount; i += 1) {
      const workflowId = `wf-seed-${i}`;
      adapter.saveWorkflow({
        id: workflowId,
        name: `Seed Workflow ${i}`,
        status: 'completed',
        createdAt: nowIso,
        updatedAt: nowIso,
        repoUrl: 'file:///seeded-local-repo.git',
        baseBranch: 'master',
        featureBranch: `plan/seed-${i}`,
      });
      for (let taskIndex = 0; taskIndex < TASKS_PER_SEEDED_WORKFLOW; taskIndex += 1) {
        const taskId = `${workflowId}/task-${taskIndex}`;
        adapter.saveTask(workflowId, {
          id: taskId,
          description: `Seed task ${taskIndex}`,
          status: 'completed',
          dependencies: taskIndex === 0 ? [] : [`${workflowId}/task-${taskIndex - 1}`],
          createdAt,
          config: resolveTaskConfig({ workflowId }),
          execution: { exitCode: 0, generation: 0 },
          taskStateVersion: 1,
        });
      }
    }
  });
}

async function createOwnerFixture(workflowCount: number): Promise<OwnerFixture> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'submit-latency-db-growth-'));
  const homeDir = join(tmpDir, 'home');
  vi.stubEnv('HOME', homeDir);
  vi.stubEnv('INVOKER_DB_DIR', join(homeDir, '.invoker'));
  vi.stubEnv('INVOKER_REPO_CONFIG_PATH', join(homeDir, '.invoker', 'config.json'));

  const modules = await loadModules();
  const repoUrl = join(tmpDir, 'repo.git');
  execFileSync('git', ['init', '--bare', repoUrl], { stdio: 'ignore' });

  const adapter = await modules.SQLiteAdapter.create(join(tmpDir, 'invoker.db'), { ownerCapability: true });
  seedWorkflows(adapter, modules.resolveTaskConfig, workflowCount);

  const messageBus = new modules.InMemoryBus();
  let orchestrator = new modules.Orchestrator({
    persistence: adapter as any,
    messageBus,
    maxConcurrency: 1,
    logger,
  });
  orchestrator.syncAllFromDb();

  const context = {
    logger,
    persistence: adapter,
    messageBus,
    executorRegistry: {},
    agentRegistry: {},
    repoRoot: tmpDir,
    invokerConfig: { allowGraphMutation: false },
    effectiveMaxConcurrency: 1,
    taskHandles: new Map(),
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
    homeDir,
    repoUrl,
    adapter,
    actions: modules.createGuiMutationTaskActions(context as any),
  };
}

async function measureIntakeAck(workflowCount: number): Promise<Measurement> {
  fixture = await createOwnerFixture(workflowCount);
  const samples: number[] = [];
  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    const planPath = writePlan(fixture.tmpDir, fixture.repoUrl, `n${workflowCount}-sample${sample}`);
    const startedAt = performance.now();
    await fixture.actions.executeHeadlessRun({ planPath });
    samples.push(performance.now() - startedAt);
  }
  return {
    workflowCount,
    samples,
    p50: percentile50(samples),
    max: max(samples),
  };
}

describe('headless plan intake latency under workflow table growth', () => {
  afterEach(async () => {
    if (fixture) {
      await fixture.adapter.close();
      rmSync(fixture.tmpDir, { recursive: true, force: true });
      fixture = undefined;
    }
    vi.unstubAllEnvs();
  });

  it(
    'keeps the p50 intake ack under the explicit budget as stored workflow count grows',
    async () => {
      const baseline = await measureIntakeAck(0);
      await fixture?.adapter.close();
      rmSync(fixture!.tmpDir, { recursive: true, force: true });
      fixture = undefined;

      const large = await measureIntakeAck(LARGE_WORKFLOW_COUNT);
      const details = `${formatMeasurement(baseline)}; ${formatMeasurement(large)}`;
      console.error(`[submit-latency-db-growth] ${details}`);

      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        expect(large.p50, `expected current bug to exceed budget: ${details}`).toBeGreaterThan(BUDGET_MS);
      } else {
        expect(large.p50, `plan intake ack exceeded budget: ${details}`).toBeLessThan(BUDGET_MS);
      }
    },
    180_000,
  );
});

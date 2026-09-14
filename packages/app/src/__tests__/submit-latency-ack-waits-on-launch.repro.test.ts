import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator, type TaskState } from '@invoker/workflow-core';
import {
  createGuiMutationTaskActions,
  type GuiMutationTaskActionsContext,
  type HeadlessRunMutationPayload,
} from '../ipc/gui-mutation-handlers.js';

const ACK_BUDGET_MS = 200;
const SAMPLE_COUNT = 9;
// Calibration on this task branch: M=37 had p50=186.0ms and M=38 straddled
// the budget on repeat runs (211.7ms, then 199.3ms). M=40 is the smallest
// tested ready queue that cleared the budget in five independent runs
// (p50=208.2ms..326.5ms); the committed check uses nine samples.
const LARGE_READY_TASK_COUNT = 40;

const tempHome = mkdtempSync(path.join(tmpdir(), 'invoker-submit-ack-repro-'));
const bareRepoPath = path.join(tempHome, 'repo.git');
const previousEnv = {
  HOME: process.env.HOME,
  INVOKER_DB_DIR: process.env.INVOKER_DB_DIR,
  INVOKER_REPO_CONFIG_PATH: process.env.INVOKER_REPO_CONFIG_PATH,
};

process.env.HOME = tempHome;
process.env.INVOKER_DB_DIR = path.join(tempHome, '.invoker', 'test');
process.env.INVOKER_REPO_CONFIG_PATH = path.join(tempHome, '.invoker', 'config.json');
execFileSync('git', ['init', '--bare', '--initial-branch=master', bareRepoPath], { stdio: 'ignore' });

const logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return logger; },
};

function restoreEnv(name: keyof typeof previousEnv): void {
  const value = previousEnv[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

afterAll(() => {
  restoreEnv('HOME');
  restoreEnv('INVOKER_DB_DIR');
  restoreEnv('INVOKER_REPO_CONFIG_PATH');
  rmSync(tempHome, { recursive: true, force: true });
});

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function describeSamples(label: string, readyTaskCount: number, samples: number[]): string {
  return `${label}: M=${readyTaskCount} p50=${median(samples).toFixed(1)}ms max=${Math.max(...samples).toFixed(1)}ms samples=[${samples.map((sample) => sample.toFixed(1)).join(', ')}]`;
}

async function seedReadyTasks(adapter: SQLiteAdapter, readyTaskCount: number): Promise<void> {
  const workflowCount = Math.min(readyTaskCount, 250);
  const nowIso = new Date().toISOString();
  const createdAt = new Date(nowIso);

  adapter.runInTransaction(() => {
    for (let workflowIndex = 0; workflowIndex < workflowCount; workflowIndex += 1) {
      const workflowId = `seed-workflow-${workflowIndex}`;
      adapter.saveWorkflow({
        id: workflowId,
        name: workflowId,
        createdAt: nowIso,
        updatedAt: nowIso,
        repoUrl: bareRepoPath,
        baseBranch: 'master',
        onFinish: 'none',
      });
    }

    for (let taskIndex = 0; taskIndex < readyTaskCount; taskIndex += 1) {
      const workflowId = `seed-workflow-${taskIndex % workflowCount}`;
      adapter.saveTask(workflowId, {
        id: `${workflowId}/ready-${taskIndex}`,
        description: `ready task ${taskIndex}`,
        status: 'pending',
        dependencies: [],
        createdAt,
        config: {
          workflowId,
          command: 'true',
          runnerKind: 'worktree',
          poolId: 'local',
        },
        execution: {},
      } as TaskState);
    }
  });
}

async function measureOwnerIntakeAck(readyTaskCount: number, sampleIndex: number): Promise<number> {
  const sampleDir = path.join(tempHome, `sample-${readyTaskCount}-${sampleIndex}`);
  const dbPath = path.join(sampleDir, 'invoker.db');
  const planPath = path.join(sampleDir, 'one-task-plan.yaml');
  const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });

  try {
    await seedReadyTasks(adapter, readyTaskCount);
    const messageBus = new InMemoryBus();
    const orchestrator = new Orchestrator({
      persistence: adapter,
      messageBus,
      logger,
      maxConcurrency: readyTaskCount + 1,
      deferRunningUntilLaunch: true,
      resolveRepoDefaultBranch: () => 'master',
    });
    orchestrator.syncAllFromDb();

    writeFileSync(planPath, [
      `name: ack-sample-${readyTaskCount}-${sampleIndex}`,
      `repoUrl: ${JSON.stringify(bareRepoPath)}`,
      'baseBranch: master',
      'onFinish: none',
      'tasks:',
      '  - id: new-task',
      '    description: measure intake acknowledgment latency',
      '    command: "true"',
      '',
    ].join('\n'));

    const executeTasks = vi.fn();
    const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const context = {
      logger,
      persistence: adapter,
      messageBus,
      executorRegistry: {},
      agentRegistry: {},
      repoRoot: bareRepoPath,
      invokerConfig: {},
      effectiveMaxConcurrency: readyTaskCount + 1,
      taskHandles: new Map(),
      getOrchestrator: () => orchestrator,
      setOrchestrator: vi.fn(),
      getCommandService: () => ({}),
      setCommandService: vi.fn(),
      getWorkflowMutationCoordinator: () => null,
      workflowMutationDispatcher,
      getActiveMutationContext: () => undefined,
      getRendererTaskFeed: () => ({}),
      getStartupWorkflowId: () => null,
      getLaunchDispatcher: () => null,
      requireTaskExecutor: () => ({ executeTasks }),
      getTaskExecutor: () => ({ executeTasks }),
      rebuildTaskRunner: vi.fn(),
      initServices: vi.fn(async () => {}),
      requestWorkflowMetadataPublish: vi.fn(),
      cancelDeferredWorkflowLaunch: vi.fn(),
      killRunningTask: vi.fn(async () => {}),
      buildCommandServiceInvalidationDeps: () => ({}),
    } as unknown as GuiMutationTaskActionsContext;
    const actions = createGuiMutationTaskActions(context);
    workflowMutationDispatcher.set(
      'headless.run',
      (payload) => actions.executeHeadlessRun(payload as HeadlessRunMutationPayload),
    );

    const ownerHandler = workflowMutationDispatcher.get('headless.run');
    if (!ownerHandler) throw new Error('in-process headless.run owner handler was not registered');
    const startedAt = performance.now();
    await ownerHandler({ planPath });
    const elapsedMs = performance.now() - startedAt;

    expect(executeTasks, 'the repro must not start a real task process').not.toHaveBeenCalled();
    return elapsedMs;
  } finally {
    adapter.close();
  }
}

async function measureSamples(readyTaskCount: number): Promise<number[]> {
  const samples: number[] = [];
  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    samples.push(await measureOwnerIntakeAck(readyTaskCount, sampleIndex));
  }
  return samples;
}

describe('headless.run intake acknowledgment latency with a ready-task backlog', () => {
  it(
    `acknowledges a one-task plan within ${ACK_BUDGET_MS}ms even with ${LARGE_READY_TASK_COUNT} existing ready tasks`,
    async () => {
      const baselineSamples = await measureSamples(0);
      const largeSamples = await measureSamples(LARGE_READY_TASK_COUNT);
      const baselineReport = describeSamples('baseline', 0, baselineSamples);
      const largeReport = describeSamples('large', LARGE_READY_TASK_COUNT, largeSamples);
      const report = `${baselineReport}; ${largeReport}; budget=${ACK_BUDGET_MS}ms`;
      console.log(report);

      const largeP50Ms = median(largeSamples);
      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        expect(largeP50Ms, report).toBeGreaterThan(ACK_BUDGET_MS);
      } else {
        expect(largeP50Ms, report).toBeLessThan(ACK_BUDGET_MS);
      }
    },
    180_000,
  );
});

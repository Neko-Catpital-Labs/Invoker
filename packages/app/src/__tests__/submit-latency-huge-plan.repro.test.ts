import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SQLiteAdapter } from '@invoker/data-store';
import { InMemoryBus } from '@invoker/test-kit';
import { Orchestrator } from '@invoker/workflow-core';

vi.mock('../plan-backup.js', () => ({
  backupPlan: vi.fn(() => '/tmp/invoker-huge-plan-backup.yaml'),
}));

import { loadPlanSubmissionBundle } from '../plan-submission-loader.js';

const BUDGET_MS = 200;
const SAMPLE_COUNT = 3;
const TASK_COUNTS = [10, 100, 500] as const;

type SampleResult = {
  elapsedMs: number;
  writeCount: number;
};

type Measurement = {
  taskCount: number;
  samples: number[];
  p50Ms: number;
  writeCount: number;
};

const tempHome = mkdtempSync(join(tmpdir(), 'invoker-huge-plan-home-'));
const tempDirs: string[] = [];

vi.stubEnv('HOME', tempHome);
vi.stubEnv('INVOKER_DB_DIR', join(tempHome, '.invoker'));
vi.stubEnv('INVOKER_REPO_CONFIG_PATH', join(tempHome, '.invoker', 'config.json'));

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(tempHome, { recursive: true, force: true });
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDependencyChainPlan(taskCount: number, repoUrl: string): string {
  const tasks = Array.from({ length: taskCount }, (_, index) => {
    const dependency = index === 0 ? '' : `\n    dependencies: [task-${index - 1}]`;
    return [
      `  - id: task-${index}`,
      `    description: Huge plan task ${index}`,
      '    command: "true"',
      dependency,
    ].join('\n');
  }).join('\n');

  return [
    `name: Huge Plan ${taskCount}`,
    `repoUrl: ${JSON.stringify(repoUrl)}`,
    'baseBranch: master',
    `featureBranch: repro/huge-plan-${taskCount}`,
    'onFinish: none',
    'tasks:',
    tasks,
    '',
  ].join('\n');
}

function p50(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function formatMs(value: number): string {
  return value.toFixed(1);
}

function formatMeasurement(measurement: Measurement): string {
  return [
    `tasks=${measurement.taskCount}`,
    `samples=[${measurement.samples.map(formatMs).join(', ')}]`,
    `p50=${formatMs(measurement.p50Ms)}ms`,
    `writes=${measurement.writeCount}`,
    `budget=${BUDGET_MS}ms`,
  ].join(' ');
}

async function sampleIntakeAck(taskCount: number, repoUrl: string, sampleIndex: number): Promise<SampleResult> {
  const dir = mkdtempSync(join(tmpdir(), `invoker-huge-plan-${taskCount}-sample-${sampleIndex}-`));
  tempDirs.push(dir);
  const persistence = await SQLiteAdapter.create(join(dir, 'invoker.db'), { ownerCapability: true });
  const orchestrator = new Orchestrator({
    persistence,
    messageBus: new InMemoryBus(),
    maxConcurrency: 1,
    resolveRepoDefaultBranch: () => 'master',
  });

  const saveWorkflow = vi.spyOn(persistence, 'saveWorkflow');
  const saveTask = vi.spyOn(persistence, 'saveTask');
  const logEvent = vi.spyOn(persistence, 'logEvent');

  try {
    const startedAt = performance.now();
    await loadPlanSubmissionBundle(makeDependencyChainPlan(taskCount, repoUrl), {
      persistence,
      orchestrator,
      allowGraphMutation: true,
    });
    const elapsedMs = performance.now() - startedAt;
    const writeCount = saveWorkflow.mock.calls.length + saveTask.mock.calls.length + logEvent.mock.calls.length;
    return { elapsedMs, writeCount };
  } finally {
    persistence.close();
  }
}

async function measureTaskCount(taskCount: number, repoUrl: string): Promise<Measurement> {
  const samples: number[] = [];
  let writeCount = 0;

  for (let sampleIndex = 0; sampleIndex < SAMPLE_COUNT; sampleIndex += 1) {
    const sample = await sampleIntakeAck(taskCount, repoUrl, sampleIndex);
    samples.push(sample.elapsedMs);
    writeCount = sample.writeCount;
  }

  return {
    taskCount,
    samples,
    p50Ms: p50(samples),
    writeCount,
  };
}

describe('huge plan submission latency repro', () => {
  it(
    `keeps 500-task intake acknowledgment p50 under ${BUDGET_MS}ms`,
    async () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'invoker-huge-plan-bare-repo-'));
      tempDirs.push(repoDir);
      execFileSync('git', ['init', '--bare', '--initial-branch=master', repoDir], { stdio: 'ignore' });

      const measurements = [];
      for (const taskCount of TASK_COUNTS) {
        const measurement = await measureTaskCount(taskCount, repoDir);
        measurements.push(measurement);
        console.error(`[submit-latency-huge-plan] ${formatMeasurement(measurement)}`);
      }

      const huge = measurements.find((measurement) => measurement.taskCount === 500);
      if (!huge) throw new Error('missing 500-task measurement');

      console.error(`[submit-latency-huge-plan] 500-task persistence writes=${huge.writeCount}`);

      const details = formatMeasurement(huge);
      if (process.env.INVOKER_REPRO_EXPECT === 'bug') {
        expect(
          huge.p50Ms,
          `expected current huge-plan latency bug to exceed budget: ${details}`,
        ).toBeGreaterThan(BUDGET_MS);
      } else {
        expect(
          huge.p50Ms,
          `500-task intake latency exceeded budget: ${details}`,
        ).toBeLessThan(BUDGET_MS);
      }
    },
    60_000,
  );
});
